const jwt = require("jsonwebtoken");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");
const SessionService = require("./sessionService");
const util = require("../util");

class SocketService {
  constructor(io) {
    this.io = io;
    this.sockets = {};

    /** @type {SessionService} */
    this.sessionService = null;
  }

  inject({ sessionService }) {
    this.sessionService = sessionService;
  }

  initialize() {
    this.io.on("connection", (socket) => {
      console.debug("New client connected:", socket.id);

      /* ------------------------ default ------------------------ */

      socket.on("authenticate", (token, callback) => {
        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
          if (err) {
            console.error("Authentication failed:", err);
            return;
          }
          if (decoded.uid == null) {
            console.error("Authentication failed: No uid in token");
            console.log(decoded);
            return;
          }

          const uid = decoded.uid;

          // get user info from db
          try {
            const results = await db.query("SELECT * FROM users WHERE uid = ?", [uid]);
            if (results.length === 0) {
              console.error("Authentication failed: User not found");
              return;
            }

            socket.user = results[0];
            this.sockets[decoded.id] = socket;
            console.debug(`User ${socket.user.nickname} authenticated`);
            callback(true);
          } catch (err) {
            console.error("DB query failed:", err);
            callback(false);
            return;
          }
        });
      });

      socket.on("disconnect", () => {
        console.debug("Client disconnected:", socket.id);

        // leave rooms
        if (socket?.user?.uid) {
          this.sessionService.leave(socket.user.uid);
        }
      });

      /* ------------------------ Room ------------------------ */

      socket.on("createRoom", async (callback) => {
        if (!socket.user) {
          console.error("User not authenticated");
          return;
        }

        const roomId = util.generateRandomNumberCode(6);
        const room = await this.sessionService.createRoom(roomId, socket.user.uid);
        console.info(`Room ${roomId} created by ${socket.user.nickname}`);
        callback(roomId);
      });

      socket.on("joinRoom", (roomId, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          const room = this.sessionService.getRoom(roomId);
          socket.join(roomId);
          this.sessionService.join(roomId, socket.user.uid);
          console.debug(`User ${socket.user.nickname} joined room ${roomId}`);
          callback(true);

          socket.emit("router-rtp-capabilities", room.router.rtpCapabilities);
        } catch (err) {
          console.error("Join room failed:", err);
          callback(false);
        }
      });

      socket.on("leaveRoom", (roomId) => {
        if (!socket.user) {
          console.error("User not authenticated");
          return;
        }

        socket.leave(roomId);
        console.log(`User ${socket.user.nickname} left room ${roomId}`);
      });

      socket.on("chat", (roomId, message) => {
        if (!socket.user) {
          console.error("User not authenticated");
          return;
        }

        const user = socket.user;
        this.io.to(roomId).emit("chat", { uid: user.uid, nickname: user.nickname, message });
      });

      /* ------------------------ Transports ------------------------ */

      socket.on("consume-rtp-parameters", async ({ sessionId, producerId }, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          const rtpParameters = this.sessionService.getConsumableRtpParameters(sessionId, producerId);
          callback({ rtpParameters, error: null });
        } catch (err) {
          console.error("Consume RTP parameters failed:", err);
          callback({ error: err.message });
        }
      });

      // WebRTC 전송 생성 요청 처리
      socket.on("create-transport", async ({ sessionId, direction }, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          const transport = await this.sessionService.createWebRtcTransport(socket.user.uid, sessionId, direction);
          callback({
            params: {
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });

          if (direction === "recv") {
            // notify existing producer
            const producer = this.sessionService.getExistingProducer(sessionId);
            if (producer) {
              socket.emit("new-producer", { producerId: producer.id, kind: producer.kind });
            }
          }
        } catch (error) {
          console.error("Error creating transport:", error);
          callback({ error: error.message });
        }
      });

      socket.on("connect-transport", async ({ sessionId, dtlsParameters, transportId }, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          await this.sessionService.connectWebRtcTransport(socket.user.uid, sessionId, transportId, dtlsParameters);
          callback();
        } catch (error) {
          console.error("Error connecting transport:", error);
          callback({ error: error.message });
        }
      });

      socket.on("produce", async ({ sessionId, transportId, kind, rtpParameters }, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          const producer = await this.sessionService.produce(
            socket.user.uid,
            sessionId,
            transportId,
            kind,
            rtpParameters
          );
          callback({ id: producer.id });

          // notify other clients
          socket.to(sessionId).emit("new-producer", { producerId: producer.id, kind });
        } catch (error) {
          console.error("Error producing:", error);
          callback({ error: error.message });
        }
      });

      socket.on("consume", async ({ sessionId, producerId, rtpCapabilities }, callback) => {
        try {
          if (!socket.user) {
            console.error("User not authenticated");
            return;
          }

          const consumer = await this.sessionService.consume(socket.user.uid, sessionId, producerId, rtpCapabilities);
          callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
        } catch (error) {
          console.error("Error consuming:", error);
          callback({ error: error.message });
        }
      });
    });
  }
}

module.exports = SocketService;
