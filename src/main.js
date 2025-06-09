import './style.css'
import javascriptLogo from './javascript.svg'
import viteLogo from '/vite.svg'
import { initDiceBox, rollDie } from './dice/dicebox.js'
import { setupCounter } from './counter.js'
window.addEventListener('DOMContentLoaded', async () => {
  const button = document.createElement('button')
  button.textContent = '🎲 Кинути D20'
  button.style.padding = '1rem'
  button.style.fontSize = '1.2rem'
  document.body.appendChild(button)

  await initDiceBox()

  button.addEventListener('click', () => {
    rollDie('d20')
  })
})
document.querySelector('#app').innerHTML = `
  <div>
    <a href="https://vite.dev" target="_blank">
      <img src="${viteLogo}" class="logo" alt="Vite logo" />
    </a>
    <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript" target="_blank">
      <img src="${javascriptLogo}" class="logo vanilla" alt="JavaScript logo" />
    </a>
    <h1>Hello Vite!</h1>
    <div class="card">
      <button id="counter" type="button"></button>
    </div>
    <p class="read-the-docs">
      Click on the Vite logo to learn more
    </p>
  </div>
`

setupCounter(document.querySelector('#counter'))
