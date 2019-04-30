import { createConnection } from './js/webrtc.js'

/** @type {HTMLInputElement} */
const $dropzoneInput = document.querySelector('#dropzone')
/** @type {HTMLLabelElement} */
const $dropzoneArea = document.querySelector('label[for="dropzone"] > *')
/** @type {HTMLUListElement} */
const $receiveList = document.querySelector('#receivelist')
/** @type {HTMLSpanElement} */
const $peers = document.querySelector('#peers')

const chunkSize = 16384

const conn = createConnection()
conn.on('open', () => {
  if (window.location.pathname.startsWith('/r/')) {
    conn.join(window.location.pathname.substring(3))
  } else {
    conn.create()
  }
})
conn.on('join', () => {
  console.log('Connected to room: ' + conn.room)
})
conn.on('peerconnected', peer => {
  peer.recvCh.addEventListener('message', reciveMsgListener)
  $peers.textContent = conn.peers.length
})
conn.on('peerdisconnected', () => {
  $peers.textContent = conn.peers.length
})
conn.on('newfileid', id => {
  files[id] = {}
})

let sending = false
function startTransfer() {
  if (!sending)
    setTimeout(async function sender() {
      const ids = Object.getOwnPropertyNames(transfers)
      let skipped = 0
      for (const id of ids) {
        const data = transfers[id]
        if (data.progress >= data.size) {
          skipped++
          continue
        }

        await data.transfer()

        const size = sizeToString(data.size)
        if (data.progress >= data.size) {
          data.text.textContent = `${data.name} (${size})`

          setProgress(1, data.progressbar)
        } else {
          const progressString = sizeToString(data.progress)
          const progress = data.progress / data.size
          data.text.textContent = `${data.name} (${progressString}/${size})`

          setProgress(progress, data.progressbar)
        }
      }
      if (skipped !== ids.length) {
        setTimeout(sender, 0)
      } else {
        sending = false
      }
    }, 0)
  sending = true
}

/** @type {{[id: string]: { size: number, name: string, progress: number, transfer(): Promise<void>, progressbar: HTMLDivElement, text: HTMLAnchorElement}}} */
const transfers = {}

$dropzoneArea.addEventListener('drop', e => {
  e.preventDefault()
  e.stopPropagation()
  $dropzoneInput.files = e.dataTransfer.files
  handleFiles()
})
$dropzoneArea.addEventListener('dragover', e => {
  e.preventDefault()
  e.stopPropagation()
})
$dropzoneInput.addEventListener('change', handleFiles)
async function handleFiles() {
  for (let i = 0; i < $dropzoneInput.files.length; i++) {
    const file = $dropzoneInput.files[i]
    if (file.size === 0) continue
    const id = await conn.genFileId()
    for (const peer of conn.peers) {
      peer.sendCh.send(JSON.stringify({ id, size: file.size, name: file.name }))
    }
    const reader = new FileReader()
    let offset = 0
    let resolve
    reader.addEventListener('error', error => console.error('Error reading file:', error))
    reader.addEventListener('abort', event => console.log('File reading aborted:', event))
    reader.addEventListener('load', e => {
      for (const peer of conn.peers) {
        peer.sendCh.send(`"${id}"`)
        peer.sendCh.send(e.target.result)
      }
      transfers[id].progress += e.target.result.byteLength
      resolve && resolve()
    })

    const text = document.createElement('span')
    const li = document.createElement('li')
    const { svg, circle } = createProgress()
    li.appendChild(svg)
    li.appendChild(text)
    $receiveList.appendChild(li)

    setProgress(0, circle)
    transfers[id] = {
      name: file.name,
      size: file.size,
      progress: 0,
      transfer: () => new Promise(res => {
        resolve = res
        reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize))
      }),
      progressbar: circle,
      text
    }
  }
  startTransfer()
}

/** @type {{[id: string]: { size: number, name: string, done: boolean, progress: number, buffer: ArrayBuffer[], progressbar: SVGCircleElement, text: HTMLAnchorElement}}} */
const files = {}

/** @type {string | null} */
let readToId = null

const sizeToString = size => {
  if (size > 1000000000000) {
    return `${(size / 1000000000000).toFixed(2)}TB`
  } else if (size > 1000000000) {
    return `${(size / 1000000000).toFixed(2)}GB`
  } else if (size > 1000000) {
    return `${(size / 1000000).toFixed(2)}MB`
  } else if (size > 1000) {
    return `${(size / 1000).toFixed(2)}KB`
  }
  return size + 'B'
}

/**
 *
 * @param {MessageEvent} e
 */
function reciveMsgListener(e) {
  if (e.data instanceof ArrayBuffer) {
    if (readToId === null) return console.error('Recived buffer but not where to put it')

    const file = files[readToId]

    file.buffer.push(e.data)
    file.progress += e.data.byteLength

    if (file.size >= file.progress && !file.done) {
      const received = new Blob(file.buffer)
      const size = sizeToString(file.size)
      file.done = true
      file.text.textContent = `${file.name} (${size})`
      file.text.href = URL.createObjectURL(received)

      // file.text.click()
    } else if (!file.done) {
      const size = sizeToString(file.size)
      const receivedSize = sizeToString(file.progress)

      file.text.textContent = `${file.name} (${receivedSize}/${size})`
    }
    setProgress(file.progress / file.size, file.progressbar)

    readToId = null
  } else {
    try {
      const json = JSON.parse(e.data)

      if (typeof json === 'string') {
        readToId = json
      } else if (
        typeof json === 'object' &&
        typeof json.id === 'string' &&
        typeof json.size === 'number' &&
        typeof json.name === 'string'
      ) {
        const text = document.createElement('a')
        const size = sizeToString(json.size)
        text.textContent = `Receiving ${json.name} (0B/${size})`
        text.download = json.name
        const li = document.createElement('li')
        const { svg, circle } = createProgress()
        li.appendChild(svg)
        li.appendChild(text)
        $receiveList.appendChild(li)

        setProgress(0, circle)
        files[json.id] = {
          done: false,
          progress: 0,
          buffer: [],
          name: json.name,
          size: json.size,
          progressbar: circle,
          text
        }
      } else {
        console.error('recived invalid data', e.data)
      }
    } catch {
      console.error('failed to parse data recived', e.data)
    }
  }
}

function setProgress(progress, element) {
  if (
    !element ||
    !element.style ||
    !element.style.strokeDasharray ||
    !element.style.strokeDashoffset ||
    typeof progress !== 'number'
  )
    return

  if (progress < 0) {
    element.style.strokeDashoffset = element.style.strokeDasharray
    element.setAttribute('stroke', 'blue')
    element.setAttribute('fill', 'lightblue')
  } else if (progress > 1) {
    element.style.strokeDashoffset = 0
    element.setAttribute('stroke', 'green')
    element.setAttribute('fill', 'lightgreen')
  } else {
    const circumference = parseFloat(element.style.strokeDasharray)
    element.style.strokeDashoffset = circumference - progress * circumference
    element.setAttribute('stroke', 'blue')
    element.setAttribute('fill', 'lightblue')
  }
}

function createProgress() {
  // <svg class="progress-ring" width="120" height="120">
  //   <circle class="progress-ring__circle" stroke="white" stroke-width="4" fill="transparent" r="52" cx="60" cy="60"/>
  // </svg>

  const strokeWidth = 2
  const circleRadius = 20

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('progress-ring')
  svg.setAttribute('width', (circleRadius + strokeWidth) * 2)
  svg.setAttribute('height', (circleRadius + strokeWidth) * 2)
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.classList.add('progress-ring__circle')
  circle.setAttribute('stroke', 'blue')
  circle.setAttribute('stroke-width', strokeWidth)
  circle.setAttribute('r', circleRadius)
  circle.setAttribute('cx', circleRadius + strokeWidth)
  circle.setAttribute('cy', circleRadius + strokeWidth)
  circle.setAttribute('fill', 'lightblue')
  circle.style.strokeDashoffset = 2 * circleRadius * Math.PI
  circle.style.strokeDasharray = 2 * circleRadius * Math.PI

  circle.addEventListener('transitionend', () => {
    if (circle.style.strokeDashoffset === '0') {
      circle.setAttribute('stroke', 'green')
      circle.setAttribute('fill', 'lightgreen')
    }
  })

  svg.appendChild(circle)

  return { svg, circle }
}
