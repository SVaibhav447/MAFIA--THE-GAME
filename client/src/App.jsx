import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import {
  ArrowLeft, Check, ChevronRight, CircleHelp, Copy, Crown, Eye,
  Fingerprint, Heart, Moon, Send, Shield, Skull, SkipForward, Sparkles, Sun, Users, Wifi,
} from 'lucide-react'
import './App.css'

const savedId = sessionStorage.getItem('mafia-player-id') || crypto.randomUUID()
sessionStorage.setItem('mafia-player-id', savedId)
const storedSession = JSON.parse(sessionStorage.getItem('mafia-session') || 'null')
const roleMeta = {
  mafia: { label: 'Mafia', icon: Skull, description: 'Choose someone to remove from the town each night.', color: 'red' },
  detective: { label: 'Detective', icon: Eye, description: 'Investigate one player each night. The truth is yours to use.', color: 'blue' },
  doctor: { label: 'Doctor', icon: Heart, description: 'Protect one player from the night’s attack.', color: 'green' },
  villager: { label: 'Villager', icon: Users, description: 'Listen closely. Find the Mafia before they find you.', color: 'gold' },
}

function App() {
  const socketRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [room, setRoom] = useState(null)
  const [playerId, setPlayerId] = useState(savedId)
  const [role, setRole] = useState(null)
  const [allies, setAllies] = useState([])
  const [name, setName] = useState(storedSession?.name || '')
  const [roomCodeInput, setRoomCodeInput] = useState('')
  const [error, setError] = useState('')
  const [selectedTarget, setSelectedTarget] = useState('')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [investigation, setInvestigation] = useState(null)
  const [now, setNow] = useState(0)
  const [copied, setCopied] = useState(false)
  const [currentNarration, setCurrentNarration] = useState(null)
  const [completedNarration, setCompletedNarration] = useState([])
  const narrationQueueRef = useRef([])
  const narrationRunRef = useRef([])
  const currentNarrationRef = useRef(null)
  const seenNarrationRef = useRef(new Set())
  const roomRef = useRef(null)
  const chatEndRef = useRef(null)

  useEffect(() => {
    const socket = io(import.meta.env.VITE_SERVER_URL || undefined)
    socketRef.current = socket
    socket.on('connect', () => {
      setConnected(true)
      const session = JSON.parse(sessionStorage.getItem('mafia-session') || 'null')
      if (session?.code && session?.name) {
        socket.emit('room:join', { ...session, playerId: sessionStorage.getItem('mafia-player-id') }, (result) => {
          if (result?.room) setRoom(result.room)
          if (result?.playerId) setPlayerId(result.playerId)
        })
      }
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('room:update', (nextRoom) => {
      const isRejoiningActiveGame = roomRef.current === null && nextRoom.status === 'active'
      roomRef.current = nextRoom
      setRoom(nextRoom)
      if (nextRoom.status === 'lobby') return
      let unseen = (nextRoom.log || []).filter((entry) => !seenNarrationRef.current.has(entry.id))
      if (isRejoiningActiveGame) {
        const latestId = nextRoom.log?.at(-1)?.id
        nextRoom.log?.filter((entry) => entry.id !== latestId).forEach((entry) => seenNarrationRef.current.add(entry.id))
        unseen = unseen.filter((entry) => entry.id === latestId)
      }
      unseen.forEach((entry) => seenNarrationRef.current.add(entry.id))
      if (unseen.length === 0) return
      if (!currentNarrationRef.current && narrationQueueRef.current.length === 0) narrationRunRef.current = []
      narrationRunRef.current.push(...unseen)
      setCompletedNarration([])
      narrationQueueRef.current.push(...unseen)
      if (currentNarrationRef.current || narrationQueueRef.current.length === 0) return
      const first = narrationQueueRef.current.shift()
      currentNarrationRef.current = first
      setCurrentNarration(first)
    })
    socket.on('game:role', (details) => {
      setRole(details)
      setAllies(details.allies || [])
    })
    socket.on('chat:message', (message) => setMessages((current) => [...current.slice(-79), message]))
    socket.on('game:investigation', setInvestigation)
    socket.on('connect_error', () => setError('Could not reach the game server. Start the app with npm run dev.'))
    return () => socket.disconnect()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages])

  const currentPlayer = room?.players.find((player) => player.id === playerId)
  const isHost = room?.hostId === playerId
  const secondsLeft = room?.deadline ? Math.max(0, Math.ceil((room.deadline - now) / 1000)) : null
  const aliveCount = room?.players.filter((player) => player.alive).length || 0
  const roleInfo = roleMeta[role?.role]
  const RoleIcon = roleInfo?.icon || Fingerprint
  useEffect(() => {
    if (!currentNarration) return undefined
    const timer = window.setTimeout(() => {
      const next = narrationQueueRef.current.shift() || null
      currentNarrationRef.current = next
      setCurrentNarration(next)
      if (!next) {
        const completed = narrationRunRef.current
        narrationRunRef.current = []
        setCompletedNarration(completed)
      }
    }, 4000)
    return () => window.clearTimeout(timer)
  }, [currentNarration])

  function storeSession(code, playerName, id) {
    sessionStorage.setItem('mafia-player-id', id)
    sessionStorage.setItem('mafia-session', JSON.stringify({ code, name: playerName }))
    setPlayerId(id)
    setRoomCodeInput(code)
  }

  function enterRoom(event, mode) {
    event.preventDefault()
    setError('')
    const socket = socketRef.current
    if (!socket?.connected) return setError('Game server is not connected yet.')
    const action = mode === 'create' ? 'room:create' : 'room:join'
    const payload = { name: name.trim(), playerId }
    if (mode === 'join') payload.code = roomCodeInput
    socket.emit(action, payload, (result) => {
      if (result?.error) return setError(result.error)
      setRoom(result.room)
      storeSession(result.room.code, name.trim(), result.playerId)
      setRole(null)
      setMessages([])
    })
  }

  function sendNightAction() {
    if (!selectedTarget) return
    socketRef.current.emit('game:action', { code: room.code, playerId, targetId: selectedTarget }, (result) => {
      if (result?.error) setError(result.error)
      else setError('Your choice is locked in.')
    })
  }

  function castVote(targetId = selectedTarget) {
    socketRef.current.emit('game:vote', { code: room.code, playerId, targetId: targetId || null }, (result) => {
      if (result?.error) setError(result.error)
      else setError(targetId ? 'Vote recorded. The town is waiting for everyone.' : 'You abstained. The town is waiting for everyone.')
    })
  }

  function sendMessage(event) {
    event.preventDefault()
    if (!draft.trim()) return
    socketRef.current.emit('chat:send', { code: room.code, playerId, message: draft }, (result) => {
      if (result?.error) setError(result.error)
      else setDraft('')
    })
  }

  async function copyRoomCode() {
    await navigator.clipboard.writeText(room.code)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  function returnHome() {
    if (room) socketRef.current.emit('room:leave', { code: room.code, playerId })
    sessionStorage.removeItem('mafia-session')
    setRoom(null)
    roomRef.current = null
    setRole(null)
    setMessages([])
    narrationQueueRef.current = []
    narrationRunRef.current = []
    currentNarrationRef.current = null
    setCurrentNarration(null)
    setCompletedNarration([])
    seenNarrationRef.current.clear()
    setError('')
  }

  const canActAtNight = room?.phase === 'night' && currentPlayer?.alive && ['mafia', 'doctor', 'detective'].includes(role?.role)
  const canVote = room?.phase === 'voting' && currentPlayer?.alive
  const canChat = (room?.status !== 'active' || currentPlayer?.alive) && (room?.phase !== 'night' || role?.role === 'mafia')
  const isDayTheme = room?.status === 'active' && ['day', 'voting'].includes(room.phase)

  return (
    <main className={`app-shell ${isDayTheme ? 'theme-day' : 'theme-night'}`}>
      <header className="topbar">
        <a className="brand" href="#home" onClick={(event) => { event.preventDefault(); returnHome() }}>
          <span className="brand-mark"><Skull size={17} /></span>
          <span>MAFIA</span>
        </a>
        <div className="topbar-right">
          <span className={`connection ${connected ? 'is-online' : ''}`}><span className="connection-dot" />{connected ? 'LIVE SERVER' : 'CONNECTING'}</span>
          <span className="topbar-divider" />
          <button className="icon-button help-button" type="button" title="How to play" onClick={() => setError('Mafia wins by matching or outnumbering the town. The town wins by finding every Mafia member. Roles act at night; everyone votes by day.')}><CircleHelp size={17} /></button>
        </div>
      </header>

      {!room ? (
        <section className="landing">
          <div className="landing-copy">
            <div className="eyebrow"><span className="eyebrow-line" />A SOCIAL DEDUCTION GAME <span className="eyebrow-dot">·</span> 4–12 PLAYERS</div>
            <h1>The town is<br /><em>not</em> what it seems.</h1>
            <p className="landing-description">By day, this town looks like any other. By night, someone disappears. Read the room, uncover the liars, and survive long enough to call them out.</p>
            <div className="game-facts">
              <div className="fact"><span className="fact-icon"><Users size={16} /></span><span><strong>4–12</strong><small>PLAYERS</small></span></div>
              <div className="fact"><span className="fact-icon"><Moon size={16} /></span><span><strong>15–30</strong><small>MINUTES</small></span></div>
              <div className="fact"><span className="fact-icon"><Fingerprint size={16} /></span><span><strong>4</strong><small>UNIQUE ROLES</small></span></div>
            </div>
          </div>

          <section className="entry-panel" aria-label="Join or create a game">
            <div className="panel-topline"><span>YOUR NEXT BAD DECISION</span><Sparkles size={16} /></div>
            <h2>Enter the town</h2>
            <p className="panel-subtitle">Pick a name. We’ll take it from here.</p>
            <form onSubmit={(event) => enterRoom(event, 'create')}>
              <label className="field-label" htmlFor="player-name">YOUR NAME</label>
              <input id="player-name" className="text-field" maxLength={18} placeholder="e.g. The Mayor" value={name} onChange={(event) => setName(event.target.value)} required />
              <button className="primary-button create-button" type="submit" disabled={!connected}><span>Create a new game</span><ChevronRight size={18} /></button>
            </form>
            <div className="form-divider"><span />OR JOIN A TOWN<span /></div>
            <form className="join-form" onSubmit={(event) => enterRoom(event, 'join')}>
              <label className="field-label" htmlFor="room-code">ROOM CODE</label>
              <div className="join-row"><input id="room-code" className="text-field code-field" maxLength={6} placeholder="ABC123" value={roomCodeInput} onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())} required /><button className="secondary-button" type="submit" disabled={!connected}><ArrowLeft size={16} /> Join</button></div>
            </form>
            {error && <p className="error-message" role="status">{error}</p>}
            <div className="panel-foot"><Shield size={14} /> Private rooms. No accounts. No alibis.</div>
          </section>
          <div className="landing-bottom"><span>NO TWO NIGHTS END THE SAME.</span><span>EST. AFTER DARK <span className="tiny-star">✳</span></span></div>
        </section>
      ) : (
        <section className="game-page">
          <div className="game-toolbar">
            <button className="back-button" type="button" onClick={returnHome}><ArrowLeft size={16} /> Leave table</button>
            <div className="room-share"><span className="room-label">ROOM</span><strong>{room.code}</strong><button className="copy-button" type="button" title="Copy room code" onClick={copyRoomCode}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div>
          </div>
          <div className="game-heading">
            <div><div className="eyebrow"><span className="eyebrow-line" />{room.status === 'lobby' ? 'THE GATHERING' : `NIGHT ${room.round || 1} · ${room.phase?.toUpperCase()}`}</div><h1>{room.status === 'lobby' ? 'Gather your people.' : room.status === 'ended' ? 'The truth is out.' : room.phase === 'night' ? 'Keep your eyes open.' : room.phase === 'voting' ? 'Make your choice.' : 'Talk while you can.'}</h1></div>
            {room.status === 'active' && <div className={`phase-clock ${room.phase === 'night' ? 'night-clock' : ''}`}><span>{room.phase === 'night' ? <Moon size={16} /> : <Sun size={16} />}{room.phase?.toUpperCase()}</span><strong>{String(Math.floor((secondsLeft || 0) / 60)).padStart(2, '0')}:{String((secondsLeft || 0) % 60).padStart(2, '0')}</strong></div>}
          </div>
          <div className="table-layout">
            <section className="table-main">
              {room.status === 'lobby' ? (
                <div className="lobby-panel">
                  <div className="lobby-banner"><div className="town-seal"><Moon size={22} /></div><div><strong>One town. A few secrets.</strong><span>Share your room code, then wait for the whole crew.</span></div><div className="player-count"><Users size={15} /> {room.players.length}<span>/12</span></div></div>
                  <div className="section-heading"><span>AT THE TABLE</span><span>{room.players.length < 4 ? `${4 - room.players.length} MORE TO START` : 'READY WHEN YOU ARE'}</span></div>
                  <div className="player-grid">{room.players.map((player, index) => <div className="player-tile" key={player.id}><div className={`player-avatar avatar-${index % 6}`}>{player.name.slice(0, 1).toUpperCase()}</div><div className="player-identity"><strong>{player.name}{player.id === playerId && <span className="you-tag">YOU</span>}</strong><small>{player.id === room.hostId ? <><Crown size={11} /> HOST</> : player.ready ? <><Check size={11} /> READY</> : 'IN TOWN'}</small></div><span className={`presence-dot ${player.connected ? 'online' : ''}`} /></div>)}{room.players.length < 12 && <div className="empty-seat"><span>+</span><small>EMPTY SEAT</small></div>}</div>
                  <div className="lobby-actions">{isHost ? <button className="primary-button start-button" type="button" disabled={room.players.length < 4} onClick={() => socketRef.current.emit('game:start', { code: room.code, playerId }, (result) => result?.error && setError(result.error))}><span>Start the game</span><ChevronRight size={18} /></button> : <button className={`secondary-button ready-button ${currentPlayer?.ready ? 'ready-active' : ''}`} type="button" onClick={() => socketRef.current.emit('player:ready', { code: room.code, playerId })}>{currentPlayer?.ready ? <Check size={16} /> : <Sparkles size={16} />}{currentPlayer?.ready ? 'You’re ready' : 'I’m ready'}</button>}<span>{isHost ? 'You’re hosting this town.' : 'The host will start when everyone is here.'}</span></div>
                </div>
              ) : (
                <>
                  {room.status === 'ended' ? (
                    <section className="endgame-reveal">
                      <div className={`winner-banner ${room.winner}`}><Sparkles size={19} /><strong>{room.winner === 'town' ? 'The town wins.' : 'The Mafia wins.'}</strong><span>Every secret is out.</span></div>
                      <div className="reveal-heading"><div><span>THE MASKS COME OFF · {room.players.length} PLAYERS</span><h2>Every face, unmasked.</h2></div><Skull size={23} /></div>
                      <div className="reveal-grid">{room.players.map((player, index) => {
                        const RevealRoleIcon = roleMeta[player.role]?.icon || Fingerprint
                        return <article className={`reveal-card role-${player.role} ${player.alive ? 'survived' : 'eliminated'}`} key={player.id} style={{ animationDelay: `${index * 55}ms` }}>
                          <span className={`reveal-avatar avatar-${index % 6}`}><RevealRoleIcon size={18} /></span>
                          <div className="reveal-player-copy"><strong>{player.name}{player.id === playerId && <span className="you-tag">YOU</span>}</strong><span className="reveal-role">{roleMeta[player.role]?.label || 'Unknown'}</span></div>
                          <span className="reveal-status">{player.alive ? <><Check size={13} /> SURVIVED</> : <><Skull size={13} /> ELIMINATED</>}</span>
                        </article>
                      })}</div>
                    </section>
                  ) : (
                    <>
                  {roleInfo && <div className={`role-banner role-${roleInfo.color}`}><div className="role-icon"><RoleIcon size={19} /></div><div><span>YOUR ROLE</span><strong>{roleInfo.label}</strong><small>{roleInfo.description}{allies.length > 0 ? ` Your partner${allies.length > 1 ? 's' : ''}: ${allies.join(', ')}.` : ''}</small></div><span className="role-spark">✳</span></div>}
                  {investigation && <div className={`investigation-banner ${investigation.isMafia ? 'found' : ''}`}><Eye size={17} /><span><strong>{investigation.targetName}</strong> is {investigation.isMafia ? 'Mafia.' : 'not Mafia.'}</span><button type="button" onClick={() => setInvestigation(null)}>×</button></div>}
                  {room.status === 'active' && <div className="action-panel">
                    <div className="action-heading"><div><span className="section-kicker">{room.phase === 'night' ? 'THE TOWN IS ASLEEP' : room.phase === 'voting' ? 'THE TOWN HAS THE FLOOR' : 'THE TOWN IS AWAKE'}</span><h2>{canActAtNight ? role?.role === 'mafia' ? 'Choose your target.' : role?.role === 'doctor' ? 'Who will you protect?' : 'Who seems suspicious?' : canVote ? 'Who do you trust least?' : room.phase === 'night' ? 'Wait for morning.' : room.phase === 'voting' ? 'Waiting on the town.' : 'The floor is open.'}</h2></div>{room.phase === 'night' ? <Moon className="phase-ornament" size={21} /> : room.phase === 'voting' ? <Fingerprint className="phase-ornament" size={21} /> : <Sun className="phase-ornament" size={21} />}</div>
                    {(canActAtNight || canVote) && <><div className="target-list">{room.players.filter((player) => player.alive && (player.id !== playerId || (canActAtNight && role?.role === 'doctor'))).map((player, index) => <button className={`target-row ${selectedTarget === player.id ? 'selected' : ''}`} type="button" key={player.id} onClick={() => setSelectedTarget(player.id)}><span className={`mini-avatar avatar-${index % 6}`}>{player.name.slice(0, 1).toUpperCase()}</span><span className="target-name">{player.id === playerId ? `${player.name} (you)` : player.name}</span>{room.phase === 'voting' && <span className="target-status">CAST VOTE</span>}{selectedTarget === player.id && <Check className="target-check" size={16} />}</button>)}</div><button className="primary-button action-submit" type="button" disabled={!selectedTarget} onClick={canVote ? castVote : sendNightAction}><span>{canVote ? 'Lock in vote' : role?.role === 'doctor' ? 'Protect player' : role?.role === 'detective' ? 'Investigate player' : 'Choose for tonight'}</span><ChevronRight size={17} /></button>{canVote && <button className="abstain-button" type="button" onClick={() => castVote(null)}><SkipForward size={15} /> Abstain this round</button>}</>}
                    {room.phase === 'day' && <div className="day-note"><Sun size={16} /><span>Share what you know. Voting begins when the clock runs out.</span></div>}
                    {!currentPlayer?.alive && room.status === 'active' && <div className="day-note"><Skull size={16} /><span>You’ve been eliminated. Stay and watch the town decide.</span></div>}
                  </div>}
                    </>
                  )}
                </>
              )}
              {error && <div className="inline-notice" role="status"><span>{error}</span><button type="button" onClick={() => setError('')}>×</button></div>}
            </section>

            <aside className="table-sidebar">
              <section className="roster-panel"><div className="sidebar-heading"><div><span className="section-kicker">THE PEOPLE</span><h2>{room.status === 'ended' ? 'Final roster' : 'Still in town'}</h2></div><span className="alive-count">{aliveCount}<small>/{room.players.length}</small></span></div><div className="roster-list">{room.players.map((player, index) => <div className={`roster-row ${!player.alive ? 'eliminated' : ''}`} key={player.id}><span className={`mini-avatar avatar-${index % 6}`}>{player.name.slice(0, 1).toUpperCase()}</span><span className="roster-name">{player.name}{player.id === playerId && <small>YOU</small>}</span>{!player.alive && <Skull size={14} />}</div>)}</div></section>
              <section className="chat-panel"><div className="sidebar-heading chat-heading"><div><span className="section-kicker">{room.phase === 'night' && role?.role === 'mafia' ? 'PRIVATE CHANNEL' : 'TOWN SQUARE'}</span><h2>{room.phase === 'night' && role?.role === 'mafia' ? 'The inner circle' : 'Whispers & rumors'}</h2></div><span className="chat-live"><span />LIVE</span></div><div className="message-list">{messages.filter((message) => message.channel === 'mafia' ? role?.role === 'mafia' : true).map((message) => <div className={`chat-message ${message.playerId === playerId ? 'mine' : ''}`} key={message.id}><span>{message.name}</span><p>{message.message}</p></div>)}{messages.length === 0 && <div className="chat-empty">{canChat ? 'A little quiet around here.' : currentPlayer?.alive ? 'The town is asleep. Keep your voice down.' : 'You have been eliminated.'}</div>}<div ref={chatEndRef} /></div>{canChat ? <form className="chat-form" onSubmit={sendMessage}><input aria-label="Write a message" maxLength={240} placeholder="Say something…" value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" title="Send message" disabled={!draft.trim()}><Send size={15} /></button></form> : <div className="chat-locked"><Skull size={13} /> You have been eliminated</div>}</section>
              <div className="sidebar-foot"><Shield size={13} /><span>YOUR ROLE IS PRIVATE. KEEP IT THAT WAY.</span></div>
            </aside>
          </div>
          {room.status !== 'lobby' && <section className="chronicle-panel" aria-live="polite" aria-relevant="additions">
            <div className="chronicle-heading"><div><span>{currentNarration ? 'NARRATOR · LIVE CHRONICLE' : 'TOWN RECORD'}</span><h2>The story so far</h2></div><span>ROUND {room.round || 1}</span></div>
            <div className="chronicle-list">{currentNarration ? <article className="chronicle-entry is-current" key={currentNarration.id}><span>NARRATING</span><p>{currentNarration.message}</p></article> : completedNarration.length > 0 ? <div className="chronicle-static-log">{completedNarration.slice().reverse().map((item) => <article className="chronicle-static-entry" key={item.id}><time>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p>{item.message}</p></article>)}</div> : <p className="chronicle-waiting">The town is gathering its thoughts.</p>}</div>
          </section>}
          {room.status === 'ended' && <button className="primary-button play-again" type="button" onClick={returnHome}>Play another round <ChevronRight size={17} /></button>}
        </section>
      )}
      <footer className="site-footer"><span>MAFIA <span>©</span> 2025</span><span className="footer-center"><Wifi size={13} /> BUILT FOR BETTER BLUFFS</span><span>THE NIGHT IS YOUNG <span className="tiny-star">✳</span></span></footer>
    </main>
  )
}

export default App
