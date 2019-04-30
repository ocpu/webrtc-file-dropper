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
  NEW_FILE_ID: 10
}

function getWSEvent(ws, event, id) {
  return new Promise(resolve => {
    ws.addEventListener('message', function temp(e) {
      const msg = JSON.parse(e.data.toString())
      if (msg.op === event && msg.d.id === id) {
        ws.removeEventListener('message', temp)
        resolve(msg)
      }
    })
  })
}
/**
 * @typedef Peer
 * @property {string} receiverId
 * @property {RTCDataChannel} recvCh
 * @property {RTCDataChannel} sendCh
 * @property {RTCPeerConnection} sender
 * @property {RTCPeerConnection} receiver
 */

/**
 * @returns {{readonly id:number,readonly peers:Peer[],readonly room:string,genFileId():Promise<string>,create():void,join(room:string):void,close():void,on(event:'open',listener:()=>void):void,on(event:'join',listener:()=>void):void,on(event:'peerconnected',listener:(peer:Peer)=>void):void,on(event:'peerdisconnected',listener:(peer:Peer)=>void):void,on(event:'newfileid',listener:(id:string)=>void):void,once<R>(event:'open',listener:()=>R):Promise<R>,once<R>(event:'join',listener:()=>R):Promise<R>,once<R>(event:'peerconnected',listener:(peer:Peer)=>R):Promise<R>,once<R>(event:'peerdisconnected',listener:(peer:Peer)=>R):Promise<R>,once<R>(event:'newfileid',listener:(id:string)=>R):Promise<R>,once(event:'open'):Promise<void>,once(event:'join'):Promise<void>,once(event:'peerconnected'):Promise<Peer>,once(event:'peerdisconnected'):Promise<Peer>,once(event:'newfileid'):Promise<string>}}
 * 
 */
export function createConnection() {
  /** @type {{[event: string]: Function[]}} */
  const eventListeners = {}

  /** @type {string} */
  let room
  /** @type {string} */
  let id
  /** @type {{receiverId:string,sendCh:RTCDataChannel,recvCh:RTCDataChannel,sender:RTCPeerConnection,receiver:RTCPeerConnection}[]} */
  let peers = []
  const ws = new WebSocket('ws://localhost:3000/gateway')

  ws.addEventListener('open', () => {
    for (const listener of eventListeners['open'] || []) {
      if (typeof listener === 'function') listener()
    }
  })

  ws.addEventListener('message', async e => {
    const msg = JSON.parse(e.data.toString())
    switch (msg.op) {
      case opcode.JOIN: {
        id = msg.d.id
        room = msg.d.room
        history.pushState({ room }, 'Room', '/r/' + room)
        for (const listener of eventListeners['join'] || []) {
          if (typeof listener === 'function') listener()
        }
        break
      }
      case opcode.PEER: {
        const peer = msg.d

        const localConnection = new RTCPeerConnection()
        const sendChannel = localConnection.createDataChannel('sendDataChannel')

        sendChannel.binaryType = 'arraybuffer'
        localConnection.addEventListener('icecandidate', async event => {
          if (event.candidate)
            ws.send(
              JSON.stringify({
                op: opcode.CANDIDATE,
                d: {
                  senderId: id,
                  candidate: event.candidate,
                  receiverId: msg.d.id
                }
              })
            )
        })

        localConnection.peerId = id
        let index = peers.findIndex(peer => peer.receiverId === msg.d.id)
        if (index === -1) index = -1 + peers.push({ receiverId: msg.d.id })
        peers[index].sendCh = sendChannel
        peers[index].sender = localConnection

        const offer = await localConnection.createOffer()
        await localConnection.setLocalDescription(offer)
        ws.send(JSON.stringify({ op: opcode.CALL, d: { id: peer.id, offer } }))
        const {
          d: { answer }
        } = await getWSEvent(ws, opcode.ANSWER, peer.id)
        await localConnection.setRemoteDescription(answer)
        break
      }
      case opcode.CALL: {
        const caller = msg.d
        const remoteConnection = new RTCPeerConnection()
        remoteConnection.addEventListener('icecandidate', async event => {
          if (event.candidate)
            ws.send(
              JSON.stringify({
                op: opcode.CANDIDATE,
                d: {
                  senderId: caller.id,
                  candidate: event.candidate,
                  receiverId: id
                }
              })
            )
        })

        let index = peers.findIndex(peer => peer.receiverId === msg.d.id)
        if (index === -1) index = -1 + peers.push({ receiverId: id })
        peers[index].receiver = remoteConnection

        remoteConnection.addEventListener('datachannel', e => {
          const receiveChannel = e.channel
          peers[index].recvCh = receiveChannel
          receiveChannel.binaryType = 'arraybuffer'
          for (const listener of eventListeners['peerconnected'] || []) {
            if (typeof listener === 'function') listener(peers[index])
          }
        })
        remoteConnection.peerId = caller.id
        await remoteConnection.setRemoteDescription(caller.offer)
        const answer = await remoteConnection.createAnswer()
        await remoteConnection.setLocalDescription(answer)
        ws.send(JSON.stringify({ op: opcode.ANSWER, d: { answer, id: caller.id } }))
        break
      }
      case opcode.CANDIDATE: {
        try {
          const peer =
            msg.d.senderId === id
              ? peers.find(peer => peer.receiverId === msg.d.receiverId).sender
              : peers.find(peer => peer.receiverId === msg.d.senderId).receiver

          if (peer.signalingState === 'stable') {
            peer.addIceCandidate(msg.d.candidate)
          } else {
            peer.addEventListener('signalingstatechange', function temp() {
              peer.addIceCandidate(msg.d.candidate)
              peer.removeEventListener('signalingstatechange', temp)
            })
          }
        } catch (e) {
          console.error(e)
        }
        break
      }
      case opcode.DISCONNECTED: {
        const peerId = peers.findIndex(it => it.receiverId === msg.d)
        if (peerId !== -1) {
          const peer = peers[peerId]
          peer.recvCh.close()
          peer.sendCh.close()
          peer.receiver.close()
          peer.sender.close()
          const [dispeer] = peers.splice(peerId, 1)
          for (const listener of eventListeners['peerdisconnected'] || []) {
            if (typeof listener === 'function') listener(dispeer)
          }
        }
        break
      }
      case opcode.NEW_FILE_ID: {
        for (const listener of eventListeners['newfileid'] || []) {
          if (typeof listener === 'function') listener(msg.d)
        }
      }
      case opcode.ANSWER:
        break // noop
      default: {
        console.log('Unknown message:', msg)
      }
    }
  })

  return {
    get id() {
      return id
    },
    get room() {
      return room
    },
    get peers() {
      return peers
    },
    join(room) {
      ws.send(
        JSON.stringify({
          op: opcode.CONNECT,
          d: { room }
        })
      )
    },
    create() {
      ws.send(JSON.stringify({ op: opcode.CREATE }))
    },
    close() {
      ws.close()
    },
    genFileId() {
      ws.send(JSON.stringify({ op: opcode.NEW_FILE_ID }))
      return this.once('newfileid')
    },
    on(event, listener) {
      eventListeners[event] = eventListeners[event] || []
      eventListeners[event].push(listener)
    },
    once(event, listener) {
      return new Promise(resolve => {
        eventListeners[event] = eventListeners[event] || []
        eventListeners[event].push(e => {
          resolve(typeof listener === 'function' ? listener(e) : e)
        })
      })
    }
  }
}
