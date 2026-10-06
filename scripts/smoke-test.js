import { io } from '../client/node_modules/socket.io-client/build/esm/index.js'

const playerIds = ['smoke-host', 'smoke-2', 'smoke-3', 'smoke-4', 'smoke-5']
const sockets = []

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io('http://localhost:3001')
    sockets.push(socket)
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve))
}

function waitFor(check, label) {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (check()) {
        clearInterval(poll)
        clearTimeout(timeout)
        resolve()
      }
    }, 20)
    const timeout = setTimeout(() => {
      clearInterval(poll)
      reject(new Error(`Timed out waiting for ${label}`))
    }, 4000)
  })
}

try {
  const players = await Promise.all(playerIds.map(() => connect()))
  const created = await emit(players[0], 'room:create', { name: 'Host', playerId: playerIds[0] })
  if (created.error) throw new Error(created.error)
  const code = created.room.code

  for (let index = 1; index < players.length; index += 1) {
    const joined = await emit(players[index], 'room:join', {
      code,
      name: `Player${index}`,
      playerId: playerIds[index],
    })
    if (joined.error) throw new Error(joined.error)
  }

  const roles = new Map()
  let latestRoom = created.room
  players.forEach((socket) => {
    socket.on('game:role', (role) => roles.set(socket, role.role))
  })
  players[0].on('room:update', (room) => { latestRoom = room })

  const started = await emit(players[0], 'game:start', { code, playerId: playerIds[0] })
  if (started.error) throw new Error(started.error)
  await waitFor(() => roles.size === players.length, 'private roles')

  if (latestRoom.players.some((player) => player.role)) {
    throw new Error('A private role was exposed in the public room update')
  }

  const roleById = new Map([...roles].map(([socket, role]) => [playerIds[players.indexOf(socket)], role]))
  const mafiaId = playerIds.find((id) => roleById.get(id) === 'mafia')
  const doctorId = playerIds.find((id) => roleById.get(id) === 'doctor')
  const victimId = playerIds.find((id) => roleById.get(id) === 'villager')

  for (const [socket, role] of roles) {
    if (!['mafia', 'doctor', 'detective'].includes(role)) continue
    const index = players.indexOf(socket)
    const playerId = playerIds[index]
    const targetId = role === 'doctor' ? playerId : role === 'mafia' ? victimId : mafiaId
    const result = await emit(socket, 'game:action', {
      code,
      playerId,
      targetId,
    })
    if (result.error) throw new Error(result.error)
  }

  await waitFor(() => latestRoom.phase === 'day', 'night resolution')
  const doctorSurvived = latestRoom.players.find((player) => player.id === doctorId)?.alive
  const victimEliminated = !latestRoom.players.find((player) => player.id === victimId)?.alive
  if (!doctorSurvived || !victimEliminated) throw new Error('Doctor self-protection or Mafia elimination did not resolve correctly')

  const chatResult = await emit(players[playerIds.indexOf(victimId)], 'chat:send', {
    code,
    playerId: victimId,
    message: 'I should not be able to send this.',
  })
  if (!chatResult.error?.includes('Eliminated players cannot chat')) {
    throw new Error('An eliminated player was allowed to chat')
  }

  console.log(JSON.stringify({
    room: code,
    players: latestRoom.players.length,
    roles: [...roles.values()].sort(),
    nextPhase: latestRoom.phase,
    publicRolesHidden: latestRoom.players.every((player) => !player.role),
    doctorCanProtectSelf: doctorSurvived,
    eliminatedChatBlocked: true,
  }, null, 2))
} finally {
  sockets.forEach((socket) => socket.disconnect())
}
