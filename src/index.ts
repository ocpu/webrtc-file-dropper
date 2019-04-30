import express from 'express'
import expressWS from 'express-ws'
import { AddressInfo } from 'net'
import { resolve } from 'path'
import { randomBytes } from 'crypto'
import fs from 'fs'
import { log } from './util'

const app = expressWS(express()).app

type Offer = { type: 'offer', sdp: string }
type Answer = { type: 'answer', sdp: string }
type ICECandidate = { candidate: string, sdpMid: string, sdpMLineIndex: number }

const rooms: { [room: string]: { fileIds: string[], peers: (import('ws') & { context: { id: string, room: string } })[] } } = {}
const ids: string[] = []

const mainLog = (...args: any) => log('main', ...args)

const opcode = {
  JOIN: 1,
  PEER: 2,
  CALL: 3,
  ANSWER: 4,
  CREATE: 5,
  CONNECT: 6,
  CANDIDATE: 7,
  ERROR: 8,
  DISCONNECTED: 9,
  NEW_FILE_ID: 10,
}

type WSMessage = { op: number, d: any };

const urlSafe = (str: string) => str.replace(/(\+|\/|=)/g, '_')

app.use(express.static(resolve(__dirname, '..', 'public')))
app.ws('/gateway', (ws: import('ws')) => {
  const context = {
    id: urlSafe(randomBytes(8).toString('base64')),
    room: ''
  }
  while (ids.includes(context.id)) context.id = urlSafe(randomBytes(8).toString('base64'))
  ids.push(context.id)

  const socketLog = (...args: any) => log('socket/' + context.id, ...args)

  const socket = ws as import('ws') & { context: { id: string, room: string } }
  socket.context = context

  ws.on('message', data => {
    const msg: WSMessage = JSON.parse(data.toString('utf8'))
    switch (msg.op) {
      case opcode.CONNECT: {
        if (socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 0, message: 'You are already in a room' } }))
          socketLog('Tried to connect to room {} while already in one', msg.d && msg.d.room)
          break
        }
        const { room }: { room: string } = msg.d
        if (room in rooms) {
          socket.send(JSON.stringify({ op: opcode.JOIN, d: { id: socket.context.id, room } }))
          socket.context.room = room
          rooms[room].peers.push(socket)
          rooms[room].peers.forEach(client => {
            if (client !== socket) {
              client.send(JSON.stringify({ op: opcode.PEER, d: { id: socket.context.id } }))
              socket.send(JSON.stringify({ op: opcode.PEER, d: { id: client.context.id } }))
            }
          })
          socketLog('Connected to room {}', room)
          break
        }
      }
      case opcode.CREATE: {
        if (socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 0, message: 'You are already in a room' } }))
          socketLog('Tried to create a room {} while already in one', msg.d && msg.d.room)
          break
        }
        do { socket.context.room = urlSafe(randomBytes(8).toString('base64')) } while (socket.context.room in rooms)

        socket.send(JSON.stringify({ op: opcode.JOIN, d: { id: socket.context.id, room: socket.context.room } }))
        rooms[socket.context.room] = { fileIds: [], peers: [socket] }
        rooms[socket.context.room].peers.forEach(client => {
          if (client !== socket)
            client.send(JSON.stringify({ op: opcode.PEER, d: { id: socket.context.id } }))
        })

        socketLog('Connected to room {}', socket.context.room)
        break
      }
      case opcode.CALL: {
        if (!socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 1, message: 'You are not in a room' } }))
          socketLog('Tried to call when not connected to a room')
          break
        }
        const { id: peerId, offer }: { id: string, offer: Offer } = msg.d

        const peer = rooms[socket.context.room].peers.find(peer => peer.context.id === peerId)

        if (peer) {
          peer.send(JSON.stringify({ op: opcode.CALL, d: { id: socket.context.id, offer } }))
          socketLog('Calling {}', peerId)
          return
        }

        socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 2, message: 'Peer not found in room' } }))
        socketLog('Tried to call a peer that is not in the room')
        break
      }
      case opcode.ANSWER: {
        if (!socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 1, message: 'You are not in a room' } }))
          socketLog('Tried to answer when not connected to a room')
          break
        }
        const { id: peerId, answer }: { id: string, answer: Answer } = msg.d

        const peer = rooms[socket.context.room].peers.find(peer => peer.context.id === peerId)

        if (peer) {
          peer.send(JSON.stringify({ op: opcode.ANSWER, d: { id: socket.context.id, answer } }))
          socketLog('Answers {}', peerId)
          return
        }

        socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 2, message: 'Peer not found in room' } }))
        socketLog('Tried to answer a peer that is not in the room')
        break
      }
      case opcode.CANDIDATE: {
        if (!socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 1, message: 'You are not in a room' } }))
          socketLog('Tried to send candidate when not connected to a room')
          break
        }
        const { senderId, candidate, receiverId }: { senderId: string, candidate: ICECandidate, receiverId: string } = msg.d

        const peer = socket.context.id === senderId
          ? rooms[socket.context.room].peers.find(peer => peer.context.id === receiverId)
          : rooms[socket.context.room].peers.find(peer => peer.context.id === senderId)

        if (peer) {
          peer.send(JSON.stringify({ op: opcode.CANDIDATE, d: { senderId, candidate, receiverId } }))
          socketLog('Sending candidate to {}', peer.context.id)
          return
        }

        socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 2, message: 'Peer not found in room' } }))
        socketLog('Tried send a candidate to a peer that is not in the room')
        break
      }
      case opcode.NEW_FILE_ID: {
        if (!socket.context.room) {
          socket.send(JSON.stringify({ op: opcode.ERROR, d: { code: 1, message: 'You are not in a room' } }))
          socketLog('Tried to generate file id when not connected to a room')
          break
        }

        let id: string
        do { id = urlSafe(randomBytes(8).toString('base64')) } while (rooms[socket.context.room].fileIds.includes(id)) 
        rooms[socket.context.room].fileIds.push(id)

        rooms[socket.context.room].peers.forEach(peer => {
          peer.send(JSON.stringify({ op: opcode.NEW_FILE_ID, d: id }))
        })

        break
      }
    }
  })

  socket.on('close', () => {
    if (socket.context.room in rooms) {
      const index = rooms[socket.context.room].peers.indexOf(socket)
      if (~index) {
        socketLog('Disconnecting from {}', socket.context.room)
        rooms[socket.context.room].peers.splice(index, 1)
        if (!rooms[socket.context.room].peers.length) {
          mainLog('Deleting room {} as there are no connections to it', socket.context.room)
          delete rooms[socket.context.room]
        } else {
          socketLog('Sending disconnection to other peers')
          rooms[socket.context.room].peers.forEach(peer => {
            peer.send(JSON.stringify({ op: opcode.DISCONNECTED, d: socket.context.id }))
          })
        }
      }
    }
  })
})
app.get(/\/.*/, (_, res) => {
  fs.createReadStream(resolve(__dirname, '..', 'public', 'index.html'), 'utf8')
    .pipe(res.status(200).contentType('html'))
})

const server = app.listen(3000, () => mainLog('Now listening on: http://localhost:' + (<AddressInfo>server.address()).port))
