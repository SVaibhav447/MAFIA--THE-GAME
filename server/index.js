import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import mongoose from 'mongoose'
import { Server } from 'socket.io'
import Game from './models/Game.js'

const app = express()
const server = http.createServer(app)
const allowedOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'] } })
const rooms = new Map()
const PORT = Number(process.env.PORT) || 3001

app.use(cors({ origin: allowedOrigin }))
app.use(express.json())
app.get('/api/health', (_request, response) => response.json({ ok: true, database: mongoose.connection.readyState === 1 }))
app.get('/api/games/recent', async (_request, response) => {
  if (mongoose.connection.readyState !== 1) return response.json([])
  try {
    const games = await Game.find().sort({ createdAt: -1 }).limit(8).lean()
    response.json(games)
  } catch {
    response.status(500).json({ error: 'Could not load match history.' })
  }
})

const roomChannel = (code) => `room:${code}`
const roleLabels = { mafia: 'Mafia', detective: 'Detective', doctor: 'Doctor', villager: 'Villager' }
const alivePlayers = (room) => room.players.filter((player) => player.alive)
const randomCode = () => randomBytes(4).toString('hex').slice(0, 6).toUpperCase()
const cleanName = (value) => String(value || '').trim().replace(/[<>]/g, '').slice(0, 18)

function serializeRoom(room) {
  return {
    code: room.code,
    status: room.status,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    hostId: room.hostId,
    winner: room.winner,
    players: room.players.map(({ id, name, alive, connected, ready, role }) => ({
      id, name, alive, connected, ready,
      ...(room.status === 'ended' ? { role } : {}),
    })),
    log: room.log.slice(-8),
  }
}

function publishRoom(room) {
  io.to(roomChannel(room.code)).emit('room:update', serializeRoom(room))
}

function addLog(room, message) {
  room.log.push({ id: randomBytes(5).toString('hex'), message, time: Date.now() })
  room.log = room.log.slice(-30)
}

function clearPhaseTimer(room) {
  if (room.timer) clearTimeout(room.timer)
  room.timer = null
}

function checkWinner(room) {
  const living = alivePlayers(room)
  const mafia = living.filter((player) => player.role === 'mafia').length
  const town = living.length - mafia
  if (mafia === 0) return 'town'
  if (mafia >= town) return 'mafia'
  return null
}

async function finishGame(room, winner) {
  clearPhaseTimer(room)
  room.status = 'ended'
  room.phase = 'ended'
  room.winner = winner
  addLog(room, winner === 'town' ? 'The town has driven out the Mafia.' : 'The Mafia now control the town.')
  if (mongoose.connection.readyState === 1) {
    Game.create({
      roomCode: room.code,
      players: room.players.map(({ name, role, alive }) => ({ name, role, alive })),
      winner,
      rounds: room.round,
      durationSeconds: Math.floor((Date.now() - room.startedAt) / 1000),
    }).catch((error) => console.error('Could not save completed game:', error.message))
  }
  publishRoom(room)
}

function openPhase(room, phase, seconds) {
  clearPhaseTimer(room)
  room.phase = phase
  room.deadline = Date.now() + seconds * 1000
  room.actions.clear()
  room.votes.clear()
  addLog(room, phase === 'night'
    ? `Night ${room.round} settles over the town. Curtains close; somewhere in the dark, someone makes a choice.`
    : phase === 'day'
      ? 'Morning reaches the square. The town gathers, counting who made it through the night.'
      : 'The whispers have run their course. Decide who the town can no longer trust.')
  publishRoom(room)
  room.timer = setTimeout(() => advancePhase(room), seconds * 1000)
}

function startGame(room) {
  if (room.status !== 'lobby' || room.players.length < 4) return false
  room.status = 'active'
  room.round = 1
  room.startedAt = Date.now()
  room.actions.clear()
  const shuffled = [...room.players].sort(() => Math.random() - 0.5)
  const mafiaCount = Math.max(1, Math.floor(room.players.length / 4))
  const roles = [
    ...Array(mafiaCount).fill('mafia'),
    ...(room.players.length >= 5 ? ['detective', 'doctor'] : ['doctor']),
  ]
  while (roles.length < room.players.length) roles.push('villager')
  shuffled.forEach((player, index) => {
    player.role = roles[index]
    player.alive = true
    io.to(player.socketId).emit('game:role', {
      role: player.role,
      label: roleLabels[player.role],
      allies: player.role === 'mafia' ? room.players.filter((other) => other.role === 'mafia' && other.id !== player.id).map(({ name }) => name) : [],
    })
  })
  addLog(room, 'Roles have been dealt. Keep yours secret.')
  openPhase(room, 'night', 40)
  return true
}

function resolveNight(room) {
  const mafiaTargetIds = [...room.actions.entries()]
    .filter(([playerId]) => room.players.find((player) => player.id === playerId)?.role === 'mafia')
    .map(([, targetId]) => targetId)
  const targetCounts = new Map()
  mafiaTargetIds.forEach((targetId) => targetCounts.set(targetId, (targetCounts.get(targetId) || 0) + 1))
  const targetId = [...targetCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const protectedId = [...room.actions.entries()].find(([playerId]) => room.players.find((player) => player.id === playerId)?.role === 'doctor')?.[1]
  const detectiveAction = [...room.actions.entries()].find(([playerId]) => room.players.find((player) => player.id === playerId)?.role === 'detective')
  if (detectiveAction) {
    const detective = room.players.find((player) => player.id === detectiveAction[0])
    const target = room.players.find((player) => player.id === detectiveAction[1])
    if (detective?.alive && target?.alive) {
      io.to(detective.socketId).emit('game:investigation', { targetId: target.id, targetName: target.name, isMafia: target.role === 'mafia' })
    }
  }
  const victim = room.players.find((player) => player.id === targetId && player.alive)
  if (!victim) addLog(room, 'The night passed without a clear target.')
  else if (victim.id === protectedId) addLog(room, 'A life was saved during the night.')
  else {
    victim.alive = false
    addLog(room, `${victim.name} did not make it through the night.`)
  }
  const winner = checkWinner(room)
  if (winner) return finishGame(room, winner)
  room.round += 1
  openPhase(room, 'day', 60)
}

function resolveVote(room) {
  const counts = new Map()
  room.votes.forEach((targetId) => counts.set(targetId, (counts.get(targetId) || 0) + 1))
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const eliminatedId = sorted.length && sorted[0][1] !== sorted[1]?.[1] ? sorted[0][0] : null
  const eliminated = room.players.find((player) => player.id === eliminatedId && player.alive)
  if (eliminated) {
    eliminated.alive = false
    addLog(room, `${eliminated.name} was voted out. They were ${roleLabels[eliminated.role]}.`)
  } else if (!sorted.length || sorted[0][0] === null) addLog(room, 'The town chose to abstain. No one was put on trial.')
  else addLog(room, 'The vote was tied. Nobody was eliminated.')
  const winner = checkWinner(room)
  if (winner) return finishGame(room, winner)
  openPhase(room, 'night', 40)
}

function advancePhase(room) {
  if (room.status !== 'active') return
  if (room.phase === 'night') resolveNight(room)
  else if (room.phase === 'day') openPhase(room, 'voting', 30)
  else if (room.phase === 'voting') resolveVote(room)
}

function acknowledge(callback, payload) {
  if (typeof callback === 'function') callback(payload)
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, playerId } = {}, callback) => {
    const playerName = cleanName(name)
    if (!playerName) return acknowledge(callback, { error: 'Enter a name first.' })
    let code = randomCode()
    while (rooms.has(code)) code = randomCode()
    const hostId = String(playerId || randomBytes(8).toString('hex'))
    const room = {
      code, status: 'lobby', phase: 'lobby', round: 0, deadline: null, hostId,
      players: [{ id: hostId, socketId: socket.id, name: playerName, alive: true, connected: true, ready: false, role: null }],
      log: [], actions: new Map(), votes: new Map(), timer: null,
    }
    rooms.set(code, room)
    socket.join(roomChannel(code))
    publishRoom(room)
    acknowledge(callback, { room: serializeRoom(room), playerId: hostId })
  })

  socket.on('room:join', ({ code, name, playerId } = {}, callback) => {
    const normalizedCode = String(code || '').trim().toUpperCase()
    const playerName = cleanName(name)
    const room = rooms.get(normalizedCode)
    if (!playerName) return acknowledge(callback, { error: 'Enter a name first.' })
    if (!room) return acknowledge(callback, { error: 'That room code was not found.' })
    const existing = room.players.find((player) => player.id === playerId)
    if (existing) {
      existing.socketId = socket.id
      existing.connected = true
      socket.join(roomChannel(room.code))
      if (room.status === 'active') socket.emit('game:role', { role: existing.role, label: roleLabels[existing.role], allies: room.players.filter((player) => player.role === 'mafia' && player.id !== existing.id).map(({ name }) => name) })
    } else {
      if (room.status !== 'lobby') return acknowledge(callback, { error: 'This game has already started.' })
      if (room.players.length >= 12) return acknowledge(callback, { error: 'This room is full (12 players).' })
      const id = String(playerId || randomBytes(8).toString('hex'))
      room.players.push({ id, socketId: socket.id, name: playerName, alive: true, connected: true, ready: false, role: null })
      socket.join(roomChannel(room.code))
    }
    publishRoom(room)
    acknowledge(callback, { room: serializeRoom(room), playerId: existing?.id || room.players.at(-1).id })
  })

  socket.on('room:leave', ({ code, playerId } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase())
    const playerIndex = room?.players.findIndex((item) => item.id === playerId)
    if (!room || playerIndex < 0) return
    socket.leave(roomChannel(room.code))
    if (room.status === 'lobby') {
      room.players.splice(playerIndex, 1)
      if (room.players.length === 0) {
        clearPhaseTimer(room)
        rooms.delete(room.code)
        return
      }
      if (room.hostId === playerId) room.hostId = room.players[0].id
    } else room.players[playerIndex].connected = false
    publishRoom(room)
  })

  socket.on('player:ready', ({ code, playerId } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase())
    const player = room?.players.find((item) => item.id === playerId)
    if (!player || room.status !== 'lobby') return
    player.ready = !player.ready
    publishRoom(room)
  })

  socket.on('game:start', ({ code, playerId } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase())
    if (!room) return acknowledge(callback, { error: 'Room not found.' })
    if (room.hostId !== playerId) return acknowledge(callback, { error: 'Only the host can start the game.' })
    if (room.players.length < 4) return acknowledge(callback, { error: 'You need at least 4 players to begin.' })
    startGame(room)
    acknowledge(callback, { ok: true })
  })

  socket.on('game:action', ({ code, playerId, targetId } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase())
    const player = room?.players.find((item) => item.id === playerId)
    const target = room?.players.find((item) => item.id === targetId)
    if (!room || room.status !== 'active' || room.phase !== 'night') return acknowledge(callback, { error: 'It is not night.' })
    if (!player?.alive || !target?.alive || (player.id === target.id && player.role !== 'doctor')) return acknowledge(callback, { error: 'Choose a living player other than yourself.' })
    if (!['mafia', 'doctor', 'detective'].includes(player.role)) return acknowledge(callback, { error: 'Your role has no night action.' })
    room.actions.set(player.id, target.id)
    acknowledge(callback, { ok: true })
    const eligible = alivePlayers(room).filter((item) => ['mafia', 'doctor', 'detective'].includes(item.role))
    if (eligible.every((item) => room.actions.has(item.id))) advancePhase(room)
  })

  socket.on('game:vote', ({ code, playerId, targetId } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase())
    const player = room?.players.find((item) => item.id === playerId)
    const abstained = targetId == null
    const target = abstained ? null : room?.players.find((item) => item.id === targetId)
    if (!room || room.status !== 'active' || room.phase !== 'voting') return acknowledge(callback, { error: 'Voting is not open.' })
    if (!player?.alive) return acknowledge(callback, { error: 'Only living players can vote.' })
    if (!abstained && (!target?.alive || player.id === target.id)) return acknowledge(callback, { error: 'Choose a living player other than yourself.' })
    room.votes.set(player.id, abstained ? null : target.id)
    acknowledge(callback, { ok: true })
    publishRoom(room)
    if (alivePlayers(room).every((item) => room.votes.has(item.id))) resolveVote(room)
  })

  socket.on('chat:send', ({ code, playerId, message } = {}, callback) => {
    const room = rooms.get(String(code || '').toUpperCase())
    const player = room?.players.find((item) => item.id === playerId)
    const text = String(message || '').trim().slice(0, 240)
    if (!room || !player || !text) return acknowledge(callback, { error: 'Message could not be sent.' })
    if (!player.alive) return acknowledge(callback, { error: 'Eliminated players cannot chat.' })
    const mafiaNight = room.status === 'active' && room.phase === 'night' && player.role === 'mafia' && player.alive
    if (room.status === 'active' && room.phase === 'night' && !mafiaNight) return acknowledge(callback, { error: 'The town is asleep.' })
    const messageData = { id: randomBytes(5).toString('hex'), playerId, name: player.name, message: text, time: Date.now(), channel: mafiaNight ? 'mafia' : 'town' }
    if (mafiaNight) room.players.filter((item) => item.role === 'mafia' && item.alive).forEach((item) => io.to(item.socketId).emit('chat:message', messageData))
    else io.to(roomChannel(room.code)).emit('chat:message', messageData)
    acknowledge(callback, { ok: true })
  })

  socket.on('disconnect', () => {
    rooms.forEach((room) => {
      const player = room.players.find((item) => item.socketId === socket.id)
      if (player) {
        player.connected = false
        publishRoom(room)
      }
    })
  })
})

if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch((error) => console.warn(`MongoDB unavailable; game rooms remain in memory. ${error.message}`))
} else {
  console.log('MONGO_URI not set; completed matches will not be persisted.')
}

server.listen(PORT, () => console.log(`Mafia server listening on http://localhost:${PORT}`))
