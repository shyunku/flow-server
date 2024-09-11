const { v4: uuidv4 } = require("uuid");
const mediasoup = require("mediasoup");
const { getPublicIpv4 } = require("../util");

class SessionService {
  constructor(io) {
    this.io = io;
    this.socketService = null;

    this.rooms = {};
  }

  inject({ socketService }) {
    this.socketService = socketService;
  }

  async createRoom(roomId, creatorUid) {
    if (this.rooms[roomId]) {
      console.warn("Room already exists");
      return this.rooms[roomId];
    }

    const worker = await mediasoup.createWorker({
      logLevel: "debug",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    });
    console.info("Mediasoup Worker created for room", roomId);

    const mediaCodecs = [
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
      },
    ];

    const router = await worker.createRouter({ mediaCodecs });
    const room = {
      creatorUid,
      worker,
      router,
      transports: [],
      producers: [],
      consumers: [],
      participants: new Set(),
    };

    this.rooms[roomId] = room;
    console.info("Room created:", roomId);
    return room;
  }

  getRoom(roomId) {
    if (!this.rooms[roomId]) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return this.rooms[roomId];
  }

  // Room 삭제 및 자원 해제
  async closeRoom(roomId) {
    const room = this.rooms[roomId];
    if (!room) return;

    // 모든 Mediasoup 리소스 정리
    room.transports.forEach((transport) => transport.transport.close());
    room.worker.close();

    delete this.rooms[roomId];
    console.info(`Room ${roomId} has been closed and resources have been released.`);
  }

  async join(roomId, user) {
    const room = this.getRoom(roomId);
    const { uid, nickname } = user;
    room.participants.add(uid);
    console.info(`User ${nickname} joined session ${roomId}`);

    this.io.to(roomId).emit("userJoined", { nickname, uid });
  }

  async leave(user) {
    const { uid, nickname } = user;

    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];
      if (room.participants.has(uid)) {
        room.participants.delete(uid);
        console.info(`User ${nickname} left session ${roomId}`);

        this.io.to(roomId).emit("userLeft", { uid, nickname });
      }
    }

    setTimeout(async () => {
      await this.cleanNoHostRooms();
      await this.cleanEmptyRooms();
    }, 3000);
  }

  async cleanNoHostRooms() {
    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];
      if (!room.participants.has(room.creatorUid)) {
        await this.closeRoom(roomId);
        console.info(`Room ${roomId} has been closed by host ${room.creatorUid}`);

        // broadcast
        this.io.to(roomId).emit("sessionClosed");
      }
    }
  }

  async cleanEmptyRooms() {
    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];
      if (room.participants.size === 0) {
        await this.closeRoom(roomId);
        console.info(`Room ${roomId} has been closed due to inactivity`);
      }
    }
  }

  getExistingProducer(roomId) {
    const room = this.getRoom(roomId);
    if (room.producers.length === 0) {
      return null;
    }

    return room.producers[0];
  }

  // WebRTC Transport 생성
  async createWebRtcTransport(uid, roomId, direction) {
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);

    const address = process.env.IS_LOCAL === "true" ? "127.0.0.1" : await getPublicIpv4();
    console.debug(`Announced IP: ${address}`);

    const collectiveIceServers = [
      { urls: ["stun:stun.l.google.com:19302"] },
      {
        url: ["turn:numb.viagenie.ca"],
        credential: "muazkh",
        username: "webrtc@live.com",
      },
      {
        url: ["turn:192.158.29.39:3478?transport=udp"],
        credential: "JZEOEt2V3Qb0y27GRntt2u2PAYA=",
        username: "28224511:1379330808",
      },
      {
        url: ["turn:192.158.29.39:3478?transport=tcp"],
        credential: "JZEOEt2V3Qb0y27GRntt2u2PAYA=",
        username: "28224511:1379330808",
      },
      {
        url: ["turn:turn.bistri.com:80"],
        credential: "homeo",
        username: "homeo",
      },
      {
        url: ["turn:turn.anyfirewall.com:443?transport=tcp"],
        credential: "webrtc",
        username: "webrtc",
      },
      {
        urls: ["turn:13.250.13.83:3478?transport=udp"],
        username: "YzYNCouZM1mhqhmseWk6",
        credential: "YzYNCouZM1mhqhmseWk6",
      },
    ];

    const transport = await room.router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: address }], // 적절한 IP로 변경 필요
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      iceServers: [],
    });

    console.debug(`WebRTC Transport ${direction} created for room ${roomId}, transport ID: ${transport.id}`);
    room.transports.push({ uid, transport, direction });

    return transport;
  }

  getConsumableRtpParameters(roomId, producerId) {
    const room = this.getRoom(roomId);
    const producer = room.producers.find((p) => p.id === producerId);
    if (!producer) {
      throw new Error(`Producer ${producerId} not found`);
    }

    return producer.rtpParameters;
  }

  async connectWebRtcTransport(uid, roomId, transportId, dtlsParameters) {
    const room = this.getRoom(roomId);
    const transport = room.transports.find((t) => t.uid === uid && t.transport.id === transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    await transport.transport.connect({ dtlsParameters });
    console.debug(`WebRTC Transport connected: ${transportId}`);
  }

  async produce(uid, roomId, transportId, kind, rtpParameters) {
    const room = this.getRoom(roomId);
    const transport = room.transports.find((t) => t.uid === uid && t.transport.id === transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    const producer = await transport.transport.produce({ kind, rtpParameters });
    room.producers.push({ uid, producer, id: producer.id, rtpParameters, kind });

    console.debug(`Producer ${producer.id} created for room ${roomId}`);
    return producer;
  }

  async consume(uid, roomId, producerId, rtpCapabilities) {
    const room = this.getRoom(roomId);
    const consumerTransport = room.transports.find((t) => t.uid === uid && t.direction === "recv")?.transport;
    if (!consumerTransport) {
      throw new Error(`Consumer transport for ${uid}/${producerId} not found`);
    }

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume ${producerId}`);
    }

    const consumer = await consumerTransport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    room.consumers.push({ uid, consumer, producerId });
    console.log(`Consumer ${consumer.id} created for room ${roomId}`);
    return consumer;
  }
}

module.exports = SessionService;
