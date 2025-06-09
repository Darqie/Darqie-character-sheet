import { DiceBox } from 'dice-box'
import { Howl } from 'howler'

let diceBox = null
let sound = null

export async function initDiceBox() {
  const canvas = document.createElement('canvas')
  canvas.id = 'dice-canvas'
  canvas.style.position = 'fixed'
  canvas.style.top = '0'
  canvas.style.left = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.pointerEvents = 'none'
  document.body.appendChild(canvas)

  diceBox = new DiceBox(canvas, {
    theme: 'default',
    gravity: 9.8,
    scale: 3.5,
  })

  await diceBox.init()

  sound = new Howl({
    src: ['/assets/sounds/dice.mp3'],
  })
}

export function rollDie(type) {
  if (diceBox && sound) {
    sound.play()
    diceBox.roll(type)
  }
}
