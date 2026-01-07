// Freqs from Ovuca: https://daily.bandcamp.com/lists/colundi-aleksi-perala-interview

const audioContext = new AudioContext();

const colundiFrequencies = [
  33.7, 55, 87.7, 118, 136.1, 174.6, 210.8, 221.2, 241.5, 282.6, 344.5, 396.7, 470.9, 570.2,
  695.3, 728.1, 802, 880, 1027.5, 1174.7, 1200, 1334.3, 1396.9, 1440, 1587.1, 1642.4, 1768.6,
  1962, 2280, 2400, 2480, 2816, 3000, 3440, 3960, 4216, 4800, 5156, 6000, 7056, 8192, 8400,
  9840, 12000, 14400, 16800, 19600
];

// Filter frequencies that fall within the range of human hearing
const filteredColundiFrequencies = colundiFrequencies.filter(freq => freq >= 20 && freq <= 2000);

// Map keyboard keys to Colundi frequencies
const keyToFrequencyMap = {};
const keys = 'qwertyuiopasdfghjkl;zxcvbnm,./';

for (let i = 0; i < keys.length; i++) {
  keyToFrequencyMap[keys[i]] = filteredColundiFrequencies[i % filteredColundiFrequencies.length];
}

function playColundiSynth(time, frequency, duration) {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.frequency.setValueAtTime(frequency, time);
  gainNode.gain.setValueAtTime(0.5, time);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  const attack = 0.05;
  const release = duration - attack;

  gainNode.gain.setValueAtTime(0.5, time);
  gainNode.gain.linearRampToValueAtTime(0.1, time + attack);
  gainNode.gain.linearRampToValueAtTime(0, time + attack + release);

  oscillator.start(time);
  oscillator.stop(time + attack + release);
}

const pressedKeys = new Set();

document.addEventListener('keydown', (event) => {
  if (keyToFrequencyMap[event.key] && !pressedKeys.has(event.key)) {
    pressedKeys.add(event.key);
    playColundiSynth(audioContext.currentTime, keyToFrequencyMap[event.key], 1.5);
  }
});

document.addEventListener('keyup', (event) => {
  pressedKeys.delete(event.key);
});
