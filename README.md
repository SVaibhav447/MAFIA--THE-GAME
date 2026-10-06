# MAFIA

A real-time social deduction game built with React, Express, Socket.IO, and MongoDB.

## Run locally

1. Install Node.js 20.19+ or 22.12+.
2. From this folder, run `npm install` and `npm install --prefix client`.
3. Copy `.env.example` to `.env`. MongoDB is optional; without `MONGO_URI`, rooms still work and completed games are not persisted.
4. Run `npm run dev` and open [http://localhost:5173](http://localhost:5173).

Create a room and share its six-character code. A room needs at least four players to start. The server assigns roles and resolves night actions, discussion, and voting; players may abstain during a vote. Completed match history is stored in MongoDB when connected.

## Roles

Mafia secretly choose a player to eliminate. The Detective investigates one player each night. The Doctor protects one player. Everyone else is a Villager. The town wins when all Mafia are out; Mafia win when they equal or outnumber the remaining town.
