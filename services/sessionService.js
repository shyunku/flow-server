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
        parameters: {
          maxplaybackrate: 48000,
          stereo: 1,
          useinbandfec: 1,
          usedtx: 0,
          maxaveragebitrate: 128000,
        },
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
          "x-google-start-bitrate": 5000,
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
    console.info(`[Room-${roomId}] ${nickname}: joined the room`);

    this.io.to(roomId).emit("userJoined", { nickname, uid });
  }

  async leave(user) {
    const { uid, nickname } = user;

    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];
      if (room.participants.has(uid)) {
        room.participants.delete(uid);
        this.clearUserData(user);
        console.info(`[Room-${roomId}] ${nickname}: left the room`);

        this.io.to(roomId).emit("userLeft", { uid, nickname });
      }
    }

    setTimeout(async () => {
      await this.cleanNoHostRooms();
      await this.cleanEmptyRooms();
    }, 3000);
  }

  async clearUserData(user) {
    const { uid, nickname } = user;

    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];

      // clear transports
      for (const transport of room.transports) {
        if (transport.uid === uid) {
          await transport.transport.close();
          console.debug(`[Room-${roomId}] ${nickname}: transport(${transport.direction}) closed`);
        }
      }
      room.transports = room.transports.filter((t) => t.uid !== uid);

      // clear producers
      for (const producer of room.producers) {
        if (producer.uid === uid) {
          await producer.producer.close();
          console.debug(`[Room-${roomId}] ${nickname}: producer(${producer.kind}) closed`);
        }
      }
      room.producers = room.producers.filter((p) => p.uid !== uid);

      // clear consumers
      for (const consumer of room.consumers) {
        if (consumer.uid === uid) {
          await consumer.consumer.close();
          console.debug(`[Room-${roomId}] ${nickname}: consumer(${consumer.kind}) closed`);
        }
      }
      room.consumers = room.consumers.filter((c) => c.uid !== uid);
    }
  }

  async cleanNoHostRooms() {
    for (const roomId in this.rooms) {
      const room = this.rooms[roomId];
      if (!room.participants.has(room.creatorUid)) {
        await this.closeRoom(roomId);
        console.info(`[Room-${roomId}] has been closed by host ${room.creatorUid}`);

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
        console.info(`[Room-${roomId}] closed due to inactivity`);
      }
    }
  }

  getExistingProducers(roomId) {
    const room = this.getRoom(roomId);
    return room.producers;
  }

  // WebRTC Transport 생성
  async createWebRtcTransport(user, roomId, direction) {
    const { uid, nickname } = user;
    const room = this.rooms[roomId];
    if (!room) throw new Error(`Room ${roomId} not found`);

    const address = process.env.IS_LOCAL === "true" ? "127.0.0.1" : await getPublicIpv4();
    // console.debug(`Announced IP: ${address}`);

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

    console.debug(`[Room-${roomId}] ${nickname}: transport(${direction}) created as id: ${transport.id}`);
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

  async connectWebRtcTransport(user, roomId, transportId, dtlsParameters) {
    const { uid, nickname } = user;
    const room = this.getRoom(roomId);
    const transport = room.transports.find((t) => t.uid === uid && t.transport.id === transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    await transport.transport.connect({ dtlsParameters });
    console.debug(`[Room-${roomId}] ${nickname}: transport(${transport.direction}) connected`);
  }

  async produce(user, roomId, transportId, kind, rtpParameters) {
    const { uid, nickname } = user;
    const room = this.getRoom(roomId);
    const transport = room.transports.find((t) => t.uid === uid && t.transport.id === transportId);
    if (!transport) {
      throw new Error(`Transport ${transportId} not found`);
    }

    const producer = await transport.transport.produce({ kind, rtpParameters });
    room.producers.push({ uid, producer, id: producer.id, rtpParameters, kind });

    console.debug(`[Room-${roomId}] ${nickname}: producer(${kind}) created as id: ${producer.id}`);
    return producer;
  }

  async consume(user, roomId, producerId, rtpCapabilities) {
    const { uid, nickname } = user;
    const room = this.getRoom(roomId);
    const transport = room.transports.find((t) => t.uid === uid && t.direction === "recv");
    if (!transport) {
      throw new Error(`Consumer transport for ${uid}/${producerId} not found`);
    }

    const producer = room.producers.find((p) => p.id === producerId);
    if (!producer) {
      throw new Error(`Producer ${producerId} not found`);
    }

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume ${producerId}`);
    }

    const consumer = await transport.transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
    });

    room.consumers.push({ uid, consumer, producerId, kind: producer.kind });
    console.debug(`[Room-${roomId}] ${nickname}: consumer(${producer.kind}) created as id: ${consumer.id}`);

    await consumer.resume();

    return consumer;
  }
}

module.exports = SessionService;
