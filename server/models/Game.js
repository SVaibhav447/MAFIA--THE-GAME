import mongoose from 'mongoose'

const gameSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  players: [{ name: String, role: String, alive: Boolean }],
  winner: { type: String, required: true },
  rounds: { type: Number, default: 1 },
  durationSeconds: { type: Number, default: 0 },
}, { timestamps: true })

gameSchema.index({ createdAt: -1 })

export default mongoose.model('Game', gameSchema)
