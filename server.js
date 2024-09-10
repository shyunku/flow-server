const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const sfu = require("./sfu");
const dotenv = require("dotenv");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
dotenv.config();
const SocketService = require("./services/socketService");
const SessionService = require("./services/sessionService");
const db = require("./db");
const logsh = require("logsh");
logsh.init();

// Express 및 Socket.IO 설정
const app = express();
app.use(bodyParser.json());
app.use(
  cors({
    origin: "*", // 모든 출처에서의 요청 허용
    methods: ["GET", "POST"], // 허용할 HTTP 메서드
    allowedHeaders: "*", // 모든 헤더 허용
    credentials: true, // 쿠키 허용 (필요 시)
  })
);

const JwtSecret = process.env.JWT_SECRET;

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // 모든 출처에서의 요청 허용
    methods: ["GET", "POST"], // 허용할 HTTP 메서드
    credentials: true, // 쿠키 허용 (필요 시)
  },
  transports: ["websocket"],
});

const PORT = process.env.PORT || 2135;
server.listen(PORT, () => console.info(`Server is running on port ${PORT}`));

const socketService = new SocketService(io);
const sessionService = new SessionService(io);

socketService.inject({ sessionService });
sessionService.inject({ socketService });
socketService.initialize();

app.get("/", (req, res) => {
  res.json("Hello, SFU!");
});

app.post("/login", async (req, res) => {
  try {
    const { id, credential } = req.body;
    const results = await db.query("SELECT * FROM users WHERE id = ? AND credential = ?", [id, credential]);
    if (results.length === 0) {
      return res.status(401).json({ error: "Invalid user" });
    }

    const user = results[0];
    const token = jwt.sign({ uid: user.uid }, JwtSecret, { expiresIn: "24h" });

    res.json({ nickname: user.nickname, uid: user.uid, token });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/signup", async (req, res) => {
  try {
    const { id, nickname, credential } = req.body;

    // check duplicate
    const duplicate = await db.query("SELECT * FROM users WHERE id = ?", [id]);
    if (duplicate.length > 0) {
      return res.status(409).json({ error: "Duplicate user" });
    }

    const results = await db.query("INSERT INTO users (id, nickname, credential) VALUES (?, ?, ?)", [
      id,
      nickname,
      credential,
    ]);
    res.json({ id: results.insertId });
  } catch (err) {
    console.error("Signup failed:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// sfu(io);
