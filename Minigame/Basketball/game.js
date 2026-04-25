const canvas = document.querySelector("#gameCanvas");
const context = canvas.getContext("2d");
const redScoreValue = document.querySelector("#redScoreValue");
const blackScoreValue = document.querySelector("#blackScoreValue");
const possessionLabel = document.querySelector("#possessionLabel");
const resetButton = document.querySelector("#resetButton");

const pointer = {
  x: 0,
  y: 0,
  active: false,
  locked: false
};

const red = createPlayer("red", "#d8292f");
const black = createPlayer("black", "#111111");
const ball = {
  x: 0,
  y: 0,
  radius: 12,
  owner: "red"
};

const court = {
  width: 0,
  height: 0,
  leftHoop: createHoop("left"),
  rightHoop: createHoop("right")
};

const score = {
  red: 0,
  black: 0
};

let lastTime = 0;
let lastPossessionChangeAt = 0;
let message = "Red ball";
let paused = true;

resizeCanvas();
resetGame();
requestAnimationFrame(tick);

window.addEventListener("resize", () => {
  resizeCanvas();
  resetGame();
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || !event.data) {
    return;
  }

  if (event.data.type === "basketball-reset") {
    resetGame();
  }

  if (event.data.type === "basketball-pause") {
    paused = true;
  }

  if (event.data.type === "basketball-resume") {
    paused = false;
    lastTime = performance.now();
  }
});

canvas.addEventListener("pointermove", updatePointer);
canvas.addEventListener("pointerdown", (event) => {
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock();
  }
  updatePointer(event);
});

canvas.addEventListener("pointerleave", () => {
  if (!pointer.locked) {
    pointer.active = false;
  }
});

document.addEventListener("pointerlockchange", () => {
  pointer.locked = document.pointerLockElement === canvas;
  pointer.active = pointer.locked;
  if (pointer.locked) {
    pointer.x = red.x;
    pointer.y = red.y;
  }
});

resetButton.addEventListener("click", resetGame);

function createPlayer(id, color) {
  return {
    id,
    color,
    x: 0,
    y: 0,
    radius: 22,
    speed: id === "red" ? 8.4 : 2.55,
    weaveSeed: id === "red" ? 0 : Math.random() * Math.PI * 2
  };
}

function createHoop(side) {
  return {
    side,
    x: 0,
    y: 0,
    width: 34,
    height: 116
  };
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  court.width = canvas.clientWidth;
  court.height = canvas.clientHeight;
  canvas.width = Math.floor(court.width * ratio);
  canvas.height = Math.floor(court.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function resetGame() {
  const shortSide = Math.min(court.width, court.height);
  red.radius = Math.max(18, Math.min(26, shortSide * 0.035));
  black.radius = red.radius;
  ball.radius = Math.max(9, Math.min(13, shortSide * 0.018));

  court.leftHoop.width = Math.max(24, Math.min(38, court.width * 0.04));
  court.leftHoop.height = Math.max(84, Math.min(128, court.width * 0.18));
  court.leftHoop.x = court.width / 2 - court.leftHoop.height / 2;
  court.leftHoop.y = 18;

  court.rightHoop.width = court.leftHoop.width;
  court.rightHoop.height = court.leftHoop.height;
  court.rightHoop.x = court.leftHoop.x;
  court.rightHoop.y = court.height - court.rightHoop.width - 18;

  score.red = 0;
  score.black = 0;
  redScoreValue.textContent = "0";
  blackScoreValue.textContent = "0";
  placeForTipoff("red");
  postScore();
}

function placeForTipoff(owner) {
  red.x = court.width * 0.5;
  red.y = court.height * 0.68;
  black.x = court.width * 0.5;
  black.y = court.height * 0.32;
  pointer.x = red.x;
  pointer.y = red.y;
  pointer.active = false;
  setPossession(owner, `${capitalize(owner)} ball`);
}

function updatePointer(event) {
  if (pointer.locked) {
    pointer.x = clamp(pointer.x + event.movementX, red.radius + 4, court.width - red.radius - 4);
    pointer.y = clamp(pointer.y + event.movementY, red.radius + 4, court.height - red.radius - 4);
    pointer.active = true;
    return;
  }

  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left;
  pointer.y = event.clientY - rect.top;
  pointer.active = true;
}

function tick(time) {
  const delta = Math.min(32, time - lastTime || 16) / 16.67;
  lastTime = time;

  if (!paused) {
    updateRed(delta);
    updateBlack(delta);
    updateBall();
    checkSteal(time);
    checkScore(time);
  }

  draw();

  requestAnimationFrame(tick);
}

function updateRed(delta) {
  if (!pointer.active) {
    return;
  }

  moveToward(red, pointer.x, pointer.y, red.speed * delta);
}

function updateBlack(delta) {
  if (ball.owner === "red") {
    const weave = Math.sin(performance.now() / 330 + black.weaveSeed) * Math.min(92, court.width * 0.16);
    const targetX = red.x + weave;
    const targetY = red.y - Math.max(42, court.height * 0.08);
    moveToward(black, targetX, targetY, black.speed * delta);
    return;
  }

  const weave = Math.sin(performance.now() / 380 + black.weaveSeed) * Math.min(78, court.width * 0.13);
  const targetX = court.rightHoop.x + court.rightHoop.height / 2 + weave;
  const targetY = court.rightHoop.y + court.rightHoop.width / 2;
  moveToward(black, targetX, targetY, black.speed * 1.12 * delta);
}

function moveToward(player, targetX, targetY, maxStep) {
  const dx = targetX - player.x;
  const dy = targetY - player.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0.1) {
    return;
  }

  const step = Math.min(maxStep, distance);
  player.x += (dx / distance) * step;
  player.y += (dy / distance) * step;
  keepPlayerInCourt(player);
}

function keepPlayerInCourt(player) {
  player.x = clamp(player.x, player.radius + 4, court.width - player.radius - 4);
  player.y = clamp(player.y, player.radius + 4, court.height - player.radius - 4);
}

function updateBall() {
  const owner = ball.owner === "red" ? red : black;
  const offset = owner.id === "red" ? 18 : -18;
  ball.x = owner.x + offset;
  ball.y = owner.y + owner.radius * 0.15;
}

function checkSteal(time) {
  if (time - lastPossessionChangeAt < 700) {
    return;
  }

  const distance = Math.hypot(red.x - black.x, red.y - black.y);
  if (distance > red.radius + black.radius + 8) {
    return;
  }

  if (ball.owner === "red") {
    setPossession("black", "Black steal");
  } else {
    setPossession("red", "Red steal");
  }
}

function checkScore(time) {
  if (time - lastPossessionChangeAt < 700) {
    return;
  }

  if (ball.owner === "red" && isPlayerInHoop(red, court.leftHoop)) {
    score.red += 1;
    redScoreValue.textContent = String(score.red);
    placeAfterScore("black", "Red scores. Black ball");
    postScore();
  }

  if (ball.owner === "black" && isPlayerInHoop(black, court.rightHoop)) {
    score.black += 1;
    blackScoreValue.textContent = String(score.black);
    placeAfterScore("red", "Black scores. Red ball");
    postScore();
  }
}

function placeAfterScore(owner, nextMessage) {
  if (owner === "red") {
    red.x = court.width * 0.5;
    red.y = court.height * 0.68;
    black.x = court.width * 0.5;
    black.y = court.height * 0.32;
  } else {
    red.x = court.width * 0.5;
    red.y = court.height * 0.64;
    black.x = court.width * 0.5;
    black.y = court.height * 0.36;
  }

  pointer.x = red.x;
  pointer.y = red.y;
  setPossession(owner, nextMessage);
}

function setPossession(owner, nextMessage) {
  ball.owner = owner;
  message = nextMessage;
  possessionLabel.textContent = message;
  lastPossessionChangeAt = performance.now();
  updateBall();
}

function postScore() {
  window.parent.postMessage({
    type: "basketball-score",
    red: score.red,
    black: score.black,
    possession: ball.owner
  }, window.location.origin);
}

function isPlayerInHoop(player, hoop) {
  return player.x > hoop.x
    && player.x < hoop.x + hoop.height
    && player.y > hoop.y
    && player.y < hoop.y + hoop.width;
}

function draw() {
  context.clearRect(0, 0, court.width, court.height);
  drawCourt();
  drawHoop(court.leftHoop, "#d8292f");
  drawHoop(court.rightHoop, "#111111");
  drawPlayer(red);
  drawPlayer(black);
  drawBall();
}

function drawCourt() {
  context.save();
  context.strokeStyle = "rgba(255, 248, 237, 0.68)";
  context.lineWidth = 4;
  context.strokeRect(18, 18, court.width - 36, court.height - 36);

  context.beginPath();
  context.moveTo(18, court.height / 2);
  context.lineTo(court.width - 18, court.height / 2);
  context.stroke();

  context.beginPath();
  context.arc(court.width / 2, court.height / 2, Math.min(court.width, court.height) * 0.13, 0, Math.PI * 2);
  context.stroke();

  context.strokeRect(court.width * 0.28, 18, court.width * 0.44, court.height * 0.16);
  context.strokeRect(court.width * 0.28, court.height - 18 - court.height * 0.16, court.width * 0.44, court.height * 0.16);
  context.restore();
}

function drawHoop(hoop, color) {
  context.save();
  context.fillStyle = "rgba(255, 248, 237, 0.88)";
  context.strokeStyle = "#241915";
  context.lineWidth = 4;
  context.fillRect(hoop.x, hoop.y, hoop.height, hoop.width);
  context.strokeRect(hoop.x, hoop.y, hoop.height, hoop.width);

  context.strokeStyle = color;
  context.lineWidth = 7;
  context.beginPath();
  const rimY = hoop.side === "left" ? hoop.y + hoop.width + 4 : hoop.y - 4;
  context.moveTo(hoop.x + 18, rimY);
  context.lineTo(hoop.x + hoop.height - 18, rimY);
  context.stroke();
  context.restore();
}

function drawPlayer(player) {
  const hasBall = ball.owner === player.id;
  context.save();
  context.fillStyle = player.color;
  context.strokeStyle = hasBall ? "#fff8ed" : "rgba(255, 248, 237, 0.35)";
  context.lineWidth = hasBall ? 5 : 3;
  context.beginPath();
  context.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.fillStyle = player.id === "red" ? "#fff8ed" : "#f2eee6";
  context.font = `800 ${Math.max(12, player.radius * 0.78)}px Avenir Next, Segoe UI, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(player.id === "red" ? "R" : "B", player.x, player.y + 1);
  context.restore();
}

function drawBall() {
  context.save();
  context.fillStyle = "#ef7a21";
  context.strokeStyle = "#2d1b12";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();

  context.strokeStyle = "rgba(45, 27, 18, 0.78)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ball.x - ball.radius, ball.y);
  context.lineTo(ball.x + ball.radius, ball.y);
  context.moveTo(ball.x, ball.y - ball.radius);
  context.lineTo(ball.x, ball.y + ball.radius);
  context.stroke();
  context.restore();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
