const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mediasoup = require("mediasoup");
const cors = require("cors"); // CORS 라이브러리 불러오기

// Express 및 Socket.IO 설정
const app = express();

app.use(
  cors({
    origin: "*", // 모든 출처에서의 요청 허용
    methods: ["GET", "POST"], // 허용할 HTTP 메서드
    allowedHeaders: "*", // 모든 헤더 허용
    credentials: true, // 쿠키 허용 (필요 시)
  })
);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // 모든 출처에서의 요청 허용
    methods: ["GET", "POST"], // 허용할 HTTP 메서드
    credentials: true, // 쿠키 허용 (필요 시)
  },
});

app.use(express.static("public")); // 정적 파일 제공 (필요에 따라 설정)

const PORT = process.env.PORT || 2135;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));

// Mediasoup Worker 생성
let worker;
let router; // SFU 라우터
let transports = []; // 전송 객체 관리
let producers = []; // 스트림을 제공하는 클라이언트 관리
let consumers = []; // 스트림을 소비하는 클라이언트 관리

(async () => {
  worker = await mediasoup.createWorker();

  // Mediasoup이 지원하는 전체 RTP Capabilities를 가져옴
  const supportedRtpCapabilities = mediasoup.getSupportedRtpCapabilities();
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

  router = await worker.createRouter({ mediaCodecs });

  console.log("Mediasoup Worker created");

  // 클라이언트 연결 시 처리
  io.on("connection", async (socket) => {
    console.log("New client connected:", socket.id);

    // 클라이언트에 Router RTP Capabilities 전달
    socket.emit("router-rtp-capabilities", router.rtpCapabilities);

    socket.on("consume-rtp-parameters", async ({ producerId }, callback) => {
      const producer = producers.find((p) => p.id === producerId); // 프로듀서를 찾아 RTP 파라미터 가져오기
      if (!producer) {
        return callback({ error: "Producer not found." });
      }

      const rtpParameters = producer.rtpParameters; // RTP 파라미터 제공
      callback({ rtpParameters, error: null });
    });

    // WebRTC 전송 생성 요청 처리
    socket.on("create-transport", async ({ direction }, callback) => {
      try {
        const transport = await createWebRtcTransport();
        transports.push({ socketId: socket.id, transport, direction });

        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
      } catch (error) {
        console.error("Error creating transport:", error); // 오류 로그 추가
        callback({ error: error.message });
      }
    });

    // 클라이언트가 전송을 연결하도록 요청할 때 처리
    socket.on("connect-transport", async ({ dtlsParameters, transportId }, callback) => {
      try {
        console.log(transports, socket.id);

        // transportId를 통해 정확한 transport 찾기
        const transportEntry = transports.find((t) => t.transport.id === transportId);

        if (!transportEntry) {
          throw new Error("Transport not found");
        }

        const transport = transportEntry.transport;
        await transport.connect({ dtlsParameters }); // DTLS 파라미터를 사용하여 전송 연결
        callback();
        console.log(`Transport connected: ${transport.id}`); // 연결 성공 로그 추가
      } catch (error) {
        console.error("Error connecting transport:", error); // 오류 로그 추가
        callback({ error: error.message });
      }
    });

    // 클라이언트가 프로듀서 생성 요청 시 처리
    socket.on("produce", async ({ transportId, kind, rtpParameters }, callback) => {
      try {
        const transport = transports.find((t) => t.transport.id === transportId).transport;
        const producer = await transport.produce({ kind, rtpParameters });
        producers.push({ socketId: socket.id, producer, id: producer.id, rtpParameters });

        callback({ id: producer.id });

        // 다른 클라이언트들에게 새로운 프로듀서 알림
        socket.broadcast.emit("new-producer", { producerId: producer.id, kind });

        setInterval(async () => {
          const stats = await producer.getStats();
          stats.forEach((report) => {
            if (report.type === "outbound-rtp" && report.kind === "video") {
              console.log(
                `Server: Producer ${producer.id} - Bytes sent: ${report.bytesSent}, Packets sent: ${report.packetsSent}`
              );
            }
          });
        }, 5000);
      } catch (error) {
        console.error("Error producing stream:", error); // 오류 로그 추가
        callback({ error: error.message });
      }
    });

    // 클라이언트가 소비자 생성 요청 시 처리
    socket.on("consume", async ({ producerId, rtpCapabilities }, callback) => {
      try {
        const consumerTransport = transports.find((t) => t.socketId === socket.id && t.direction === "recv").transport;

        // RTP Capabilities 호환성 검사
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          console.error("Cannot consume this producer. RTP capabilities do not match.");
          callback({ error: "Cannot consume this producer." });
          return;
        }

        const consumer = await consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });

        consumers.push({ socketId: socket.id, consumer });

        await consumer.resume(); // 소비자 재개

        callback({
          id: consumer.id,
          producerId: producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });

        setInterval(async () => {
          const stats = await consumer.getStats();
          stats.forEach((report) => {
            if (report.type === "outbound-rtp" && report.kind === "video") {
              console.log(
                `Server: Consumer ${consumer.id} - Bytes sent: ${report.byteCount}, Packets sent: ${report.packetCount}`
              );
            }
          });
        }, 5000);
      } catch (error) {
        console.error("Error consuming stream:", error); // 오류 로그 추가
        callback({ error: error.message });
      }
    });

    // 클라이언트가 연결 해제 시 처리
    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
      // 클라이언트 관련 리소스 정리
      transports = transports.filter((t) => t.socketId !== socket.id);
      producers = producers.filter((p) => p.socketId !== socket.id);
      consumers = consumers.filter((c) => c.socketId !== socket.id);
    });
  });
})();

// WebRTC 전송 생성 함수
async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }], // 'YOUR_PUBLIC_IP'는 서버의 공인 IP로 변경
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  console.log("WebRTC Transport created", transport.id);

  return transport;
}
