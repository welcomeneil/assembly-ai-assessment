package com.assemblyai;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;

import javax.sound.sampled.*;
import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Spanglish Inc. AssemblyAI Universal-Streaming (v3) client.
 *
 * Corrected version of the file Spanglish sent us. Each change is marked with a "FIX #n"
 * comment. The numbers match the defect table in ../../01-root-cause.md.
 *
 * Three defects prevented this from working. Each one is sufficient to break the stream on
 * its own:
 *
 *   FIX #1  The file does not compile. main() references a class that does not exist.
 *   FIX #2  The URL declares encoding=opus while the code sends raw PCM.
 *   FIX #3  Audio chunks are 25 ms. The API requires 50 to 1000 ms.
 *
 * FIX #4, the unpinned speech_model, was written up as a fourth blocker and did not survive
 * live testing: the account default resolved to universal-3-5-pro and handled Spanish
 * correctly. It is kept as hygiene, not as a cause. See ../../07-live-verification.md, which
 * also records FIX #24, a blocker introduced by this file's own first draft.
 *
 * Build and run instructions: see ../README.md
 *
 *   ./build.sh run                                    live microphone
 *   ./build.sh run --file ../python/sample_bilingual.wav   fixed audio, repeatable
 */
public class Spanglish {

    // ---------------------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------------------

    // FIX #16: read the API key from the environment.
    // Original: private static final String API_KEY = "api_key";
    // The literal placeholder was never replaced. The server rejects it with close code 1008,
    // "Unauthorized Connection". Reading from the environment also keeps the key out of version
    // control and allows separate keys per environment.
    private static final String API_KEY = System.getenv("ASSEMBLYAI_API_KEY");

    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNELS = 1;
    private static final int SAMPLE_SIZE_IN_BITS = 16;
    private static final int BYTES_PER_SAMPLE = SAMPLE_SIZE_IN_BITS / 8;

    // FIX #3: increase the chunk size from 25 ms to 50 ms.
    // Original: FRAMES_PER_BUFFER = 400, which is 25 ms at 16 kHz.
    // The v3 API requires every binary message to contain between 50 and 1000 ms of audio.
    // Messages outside that range cause the server to close the connection with code 3007:
    // "Input duration violation: 25 ms. Expected between 50 and 1000 ms".
    // 800 frames is 50 ms and 1600 bytes. AssemblyAI documents 50 ms as the recommended size
    // for lowest latency.
    private static final int FRAMES_PER_CHUNK = 800;                       // 50 ms
    private static final int BYTES_PER_CHUNK = FRAMES_PER_CHUNK * BYTES_PER_SAMPLE; // 1600 B

    // FIX #6: increase the microphone line buffer.
    // Original: microphone.open(format, FRAMES_PER_BUFFER * 2), which is 800 bytes, or exactly
    // one chunk. A buffer that small overruns whenever the reading thread is delayed, and the
    // audio driver discards samples without reporting an error. The result is missing words in
    // the transcript. This allocates approximately one second of headroom.
    private static final int LINE_BUFFER_BYTES = BYTES_PER_CHUNK * 20;     // ~1 s

    // FIX #7: separate audio capture from network transmission.
    // Original: wsClient.send() was called directly inside the microphone read loop, so any
    // network delay stalled audio capture. This queue holds chunks between the capture thread
    // and a dedicated sender thread. When the queue is full the oldest chunk is discarded and
    // counted, which keeps capture running at a steady rate.
    private static final int SEND_QUEUE_CAPACITY = 200;                    // ~10 s of audio

    // FIX #15 (see cleanup()): maximum time to wait for the server's Termination message.
    private static final long TERMINATION_WAIT_MS = 5000;

    // FIX #22: use a regional endpoint.
    // Original: streaming.assemblyai.com, which routes to the nearest region for lowest latency
    // and provides no data residency guarantee. Court recordings should use a fixed region.
    //   streaming.us.assemblyai.com  data remains in the United States
    //   streaming.eu.assemblyai.com  data remains in the European Union
    // Set AAI_STREAMING_HOST to override.
    private static final String HOST =
            getenvOrDefault("AAI_STREAMING_HOST", "streaming.us.assemblyai.com");

    /**
     * FIX #2, FIX #4 and FIX #5: connection URL.
     *
     * Original:
     *   wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=opus&format_turns=true
     *
     * FIX #2: encoding=opus does not match the audio being sent.
     *   encoding=opus is a valid parameter value. It tells the server that every binary
     *   message contains exactly one raw Opus packet. This client captures signed 16-bit
     *   little-endian PCM through javax.sound.sampled and transmits it without encoding it.
     *   The server therefore accepts the connection, sends a Begin message, and then fails to
     *   decode the audio. Measured 2026-08-01: it reports this explicitly and immediately,
     *   "Error 3006: Failed to decode Opus packet", and closes. An earlier draft of this comment
     *   said the failure was silent and undiagnosable from the client side. That was wrong; the
     *   customer's onMessage discarded the Error message via default: break;, which is FIX #11.
     *   Note also that sample_rate is ignored for the opus, ogg_opus and aac encodings, so that
     *   parameter had no effect either.
     *   Corrected to encoding=pcm_s16le, which matches the captured format.
     *
     * FIX #4: no speech_model was specified. Downgraded from blocker to hygiene.
     *   Without this parameter the connection uses the account default. The prediction was that
     *   an established account resolves to the English-only model and transliterates Spanish.
     *   Measured 2026-08-01: it resolved to universal-3-5-pro and returned correct Spanish, so
     *   this was not a cause of the outage. AssemblyAI's documentation is still inconsistent
     *   about the default, the streaming API reference lists universal-3-5-pro while the
     *   Universal-Streaming migration guide states an omitted speech_model resolves to the
     *   English model, and async defaults vary by account creation date. That inconsistency is
     *   what produced the wrong prediction.
     *   Production code should not rely on an account default regardless: it is a dependency on
     *   account state that can change without a deploy. The model stays pinned here.
     *   language_codes biases recognition toward English and Spanish while still allowing
     *   mid-sentence switching between them, which matches the interpreter use case.
     *
     * FIX #5: format_turns is deprecated on universal-3-5-pro, where formatting is always
     *   applied. The parameter has no effect and has been removed. See FIX #12 for the related
     *   change to the print logic.
     *
     * Cost: universal-3-5-pro is approximately $0.45 per hour of open connection.
     * universal-streaming-multilingual also supports English and Spanish at approximately
     * $0.15 per hour. See 03-scaling-to-2000.md.
     */
    private static final String API_ENDPOINT = buildEndpoint();

    private static String buildEndpoint() {
        List<String[]> p = new ArrayList<>();
        p.add(new String[]{"speech_model", "universal-3-5-pro"}); // alias: u3-rt-pro
        p.add(new String[]{"encoding", "pcm_s16le"});             // matches the AudioFormat below
        p.add(new String[]{"sample_rate", String.valueOf(SAMPLE_RATE)});

        // FIX #24: language_codes is a repeated query parameter, one code per occurrence.
        // Sending language_codes=en,es is rejected by the server on connect:
        //   3006 "User Input Validation Error: Invalid 'language_codes.0': Input should be
        //   'en', 'es', ... or 'multi'"
        // The comma-joined value is parsed as a single list element, and "en,es" is not a valid
        // code. Observed against the live API on 2026-07-31; the connection closes before any
        // audio is transcribed, so this had to be corrected here too.
        p.add(new String[]{"language_codes", "en"});
        p.add(new String[]{"language_codes", "es"});

        p.add(new String[]{"language_detection", "true"}); // adds language_code to each Turn

        // FIX #25: speaker_labels is now switchable, because it is not free.
        // Measured against the live API on 2026-07-31 with sample_bilingual.wav, holding every
        // other parameter fixed:
        //   speaker_labels off -> 4 end_of_turn results, Spanish turns tagged es, full text
        //   speaker_labels on  -> 3 end_of_turn results, one of them the single word "Mr.",
        //                         every turn tagged en, most of the Spanish never finalised
        // Turns still arrive by SpeakerRevision afterwards, so the transcript is recoverable,
        // but a client that only prints end_of_turn loses them. This is one 24-second synthetic
        // sample, which is not enough to call it a defect, and separating judge from witness
        // from interpreter is the whole point for a court record -- so it stays on by default
        // and is raised with Spanglish as an open item. Set AAI_SPEAKER_LABELS=false to compare.
        if (!"false".equalsIgnoreCase(getenvOrDefault("AAI_SPEAKER_LABELS", "true"))) {
            p.add(new String[]{"speaker_labels", "true"}); // judge / witness / interpreter
            p.add(new String[]{"max_speakers", "6"});
        }
        // Additional parameters to evaluate with Spanglish:
        //   keyterms_prompt=voir dire,habeas corpus,Miranda,fiscal,testigo
        //   redact_pii=true
        //   min_turn_silence=160   (allows longer interpreter pauses)

        StringBuilder qs = new StringBuilder();
        for (String[] e : p) {
            if (qs.length() > 0) qs.append('&');
            qs.append(url(e[0])).append('=').append(url(e[1]));
        }
        return "wss://" + HOST + "/v3/ws?" + qs;
    }

    // ---------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------

    private TargetDataLine microphone;
    private final AtomicBoolean isRecording = new AtomicBoolean(false);
    private final AtomicBoolean stopRequested = new AtomicBoolean(false);
    private final Gson gson = new Gson();

    private AssemblyAIWebSocketClient wsClient;
    private Thread captureThread;
    private Thread senderThread;

    // FIX #7: queue between the capture thread and the sender thread.
    private final BlockingQueue<byte[]> sendQueue = new ArrayBlockingQueue<>(SEND_QUEUE_CAPACITY);
    private final AtomicLong droppedChunks = new AtomicLong();
    private final AtomicLong sentChunks = new AtomicLong();

    // FIX #9: single latch that signals program completion, released on every exit path.
    // Original: the latch was released only by the shutdown hook. When the server closed the
    // connection, onClose set stopRequested but never released the latch, so main() remained
    // blocked in latch.await() indefinitely. Every blocker above causes a server-side close,
    // so the observed behaviour was a process that produced no output and did not exit.
    private final CountDownLatch finished = new CountDownLatch(1);

    // FIX #15: signals receipt of the server's Termination message.
    private final CountDownLatch terminationReceived = new CountDownLatch(1);

    // FIX #10 and FIX #23: session identifier from the Begin message. This value is required
    // when reporting an issue to AssemblyAI support.
    private volatile String sessionId = "unknown";

    // FIX #13: write recorded audio to disk instead of holding it in memory.
    // Original: List<byte[]> recordedFrames accumulated every chunk for the life of the
    // session. A three-hour recording at 32 KB/s requires approximately 345 MB of heap per
    // session, which is not viable at 2,000 concurrent streams.
    private WavRecorder recorder;

    // FIX #21: cleanup() was reachable from both the shutdown hook and the catch block.
    private final AtomicBoolean cleanedUp = new AtomicBoolean(false);

    /**
     * Optional WAV file to stream instead of the microphone (--file). The mic path is what
     * Spanglish runs in production; this exists so the client can be demonstrated end to end
     * against the live API with fixed, repeatable audio and no capture hardware. Everything
     * downstream of the chunk boundary -- queue, sender thread, message handling, shutdown --
     * is the same code on both paths.
     */
    private String inputFile;

    // ---------------------------------------------------------------------------------
    // Entry point
    // ---------------------------------------------------------------------------------

    public static void main(String[] args) {
        // FIX #1: the original does not compile.
        // Original: StreamingTranscription transcription = new StreamingTranscription();
        // The class declared in this file is Spanglish. No class named StreamingTranscription
        // exists in the project, and javac reports "cannot find symbol". This means the file as
        // submitted has never been executed, and the code Spanglish actually ran differs from
        // what was sent to us.
        Spanglish transcription = new Spanglish();
        transcription.run(args);
    }

    public void run(String[] args) {
        for (int i = 0; i < args.length; i++) {
            if ("--file".equals(args[i]) && i + 1 < args.length) {
                inputFile = args[++i];
            } else {
                System.err.println("Usage: Spanglish [--file <16 kHz mono 16-bit WAV>]");
                return;
            }
        }

        // FIX #16: validate the key before opening a connection the server will reject.
        if (API_KEY == null || API_KEY.isBlank()) {
            System.err.println("ASSEMBLYAI_API_KEY is not set. Export it and re-run.");
            return;
        }

        System.out.println("AssemblyAI Universal-Streaming (v3) bilingual client");
        System.out.println("Endpoint: " + API_ENDPOINT);
        System.out.printf("Chunk: %d frames / %d bytes / %d ms%n",
                FRAMES_PER_CHUNK, BYTES_PER_CHUNK, FRAMES_PER_CHUNK * 1000 / SAMPLE_RATE);
        System.out.println("Source: " + (inputFile == null ? "microphone" : inputFile));

        // FIX #9: the shutdown hook now only sets flags.
        // Original: the hook called cleanup(), which performs blocking network and file I/O.
        // Running that work inside a shutdown hook competes with JVM termination and can
        // truncate the WAV file and drop the final transcript.
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            stopRequested.set(true);
            finished.countDown();
        }));

        try {
            if (inputFile == null) {
                recorder = new WavRecorder(
                        "recorded_audio_" + DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")
                                .withZone(ZoneId.systemDefault()).format(Instant.now()) + ".wav",
                        SAMPLE_RATE, CHANNELS, SAMPLE_SIZE_IN_BITS);
                initializeMicrophone();
            }
            connectWebSocket();

            System.out.println(inputFile == null
                    ? "Speak into your microphone in English or Spanish. Ctrl+C to stop."
                    : "Streaming file at real time. Ctrl+C to stop.");
            finished.await();
        } catch (Exception e) {
            System.err.println("Fatal: " + e);
            e.printStackTrace();
        } finally {
            cleanup();
        }
    }

    // ---------------------------------------------------------------------------------
    // Audio capture
    // ---------------------------------------------------------------------------------

    private void initializeMicrophone() throws LineUnavailableException {
        // Unchanged from the original, and correct. signed=true with bigEndian=false produces
        // signed 16-bit little-endian PCM, which is exactly pcm_s16le. The capture code was
        // always correct; only the encoding declared in the URL was wrong. See FIX #2.
        AudioFormat format = new AudioFormat(
                SAMPLE_RATE,
                SAMPLE_SIZE_IN_BITS,
                CHANNELS,
                true,   // signed
                false   // little endian
        );

        DataLine.Info info = new DataLine.Info(TargetDataLine.class, format);
        if (!AudioSystem.isLineSupported(info)) {
            throw new LineUnavailableException("Microphone not supported for " + format);
        }

        microphone = (TargetDataLine) AudioSystem.getLine(info);
        microphone.open(format, LINE_BUFFER_BYTES); // FIX #6
        System.out.println("Microphone initialized (" + LINE_BUFFER_BYTES + " byte line buffer).");
    }

    private void connectWebSocket() throws Exception {
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", API_KEY); // correct: this API does not use a Bearer prefix

        wsClient = new AssemblyAIWebSocketClient(new URI(API_ENDPOINT), headers);
        wsClient.setConnectionLostTimeout(30); // ping/pong prevents idle timeouts on NATs and LBs

        // FIX #17: check the result of connectBlocking().
        // Original: the boolean return value was discarded, so a failed handshake caused by an
        // invalid key or an exhausted rate limit was indistinguishable from a successful one.
        if (!wsClient.connectBlocking(15, TimeUnit.SECONDS)) {
            throw new IOException("WebSocket handshake failed or timed out against " + HOST);
        }
    }

    /**
     * FIX #7 and FIX #20: capture and transmission now run on separate threads with a bounded
     * queue between them. Capture must not block on network I/O, and shutdown must stop the
     * capture loop and join it before closing the audio line.
     */
    private void startAudioStreaming() {
        isRecording.set(true);
        startSender();
        if (inputFile != null) {
            startFileCapture();
        } else {
            startMicCapture();
        }
    }

    private void startMicCapture() {
        microphone.start();

        captureThread = new Thread(() -> {
            byte[] buffer = new byte[BYTES_PER_CHUNK];
            while (!stopRequested.get() && isRecording.get()) {
                try {
                    // Read until the buffer is full. microphone.read() may return fewer bytes
                    // than requested. The original sent short reads directly, which produces
                    // messages shorter than 50 ms and triggers close code 3007 intermittently.
                    int off = 0;
                    while (off < buffer.length && !stopRequested.get()) {
                        int n = microphone.read(buffer, off, buffer.length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                    if (off <= 0) continue;

                    byte[] chunk = new byte[off];
                    System.arraycopy(buffer, 0, chunk, 0, off);

                    recorder.write(chunk); // FIX #13: write to disk, constant memory
                    enqueue(chunk);
                } catch (Exception e) {
                    if (!stopRequested.get()) {
                        System.err.println("Capture error: " + e);
                    }
                    break;
                }
            }
            System.out.println("\nCapture stopped.");
        }, "aai-capture");

        captureThread.setDaemon(true);
        captureThread.start();
    }

    /**
     * Streams a WAV file through the same queue and sender as the microphone path, paced to real
     * time. Pacing matters: the v3 server closes with 3007 when audio arrives faster than it
     * plays. The trailing remainder shorter than one chunk is dropped rather than sent, because
     * a message under 50 ms triggers the same 3007.
     */
    private void startFileCapture() {
        captureThread = new Thread(() -> {
            try (AudioInputStream in = AudioSystem.getAudioInputStream(new File(inputFile))) {
                AudioFormat f = in.getFormat();
                if (f.getEncoding() != AudioFormat.Encoding.PCM_SIGNED
                        || (int) f.getSampleRate() != SAMPLE_RATE
                        || f.getChannels() != CHANNELS
                        || f.getSampleSizeInBits() != SAMPLE_SIZE_IN_BITS
                        || f.isBigEndian()) {
                    System.err.println("Unsupported WAV format: " + f);
                    System.err.printf("Expected %d Hz mono %d-bit signed little-endian PCM.%n",
                            SAMPLE_RATE, SAMPLE_SIZE_IN_BITS);
                    return;
                }

                byte[] buffer = new byte[BYTES_PER_CHUNK];
                long chunkNanos = TimeUnit.MILLISECONDS.toNanos(
                        FRAMES_PER_CHUNK * 1000L / SAMPLE_RATE);
                long nextSendAt = System.nanoTime();

                while (!stopRequested.get()) {
                    int off = 0;
                    while (off < buffer.length) {
                        int n = in.read(buffer, off, buffer.length - off);
                        if (n < 0) break;
                        off += n;
                    }
                    if (off < buffer.length) break; // end of file

                    enqueue(buffer.clone());

                    // Absolute deadline rather than a fixed sleep, so per-chunk overhead does
                    // not accumulate into sending slower than real time over a long file.
                    nextSendAt += chunkNanos;
                    long remaining = nextSendAt - System.nanoTime();
                    if (remaining > 0) TimeUnit.NANOSECONDS.sleep(remaining);
                }
                System.out.println("\nEnd of file.");
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                System.err.println("File streaming error: " + e);
            }
            // Let the queued tail reach the server before cleanup() sends Terminate.
            finished.countDown();
        }, "aai-file");

        captureThread.setDaemon(true);
        captureThread.start();
    }

    /**
     * FIX #7: non-blocking enqueue. If the sender is behind, discard the oldest chunk and record
     * the drop rather than blocking the capture thread.
     */
    private void enqueue(byte[] chunk) {
        if (!sendQueue.offer(chunk)) {
            sendQueue.poll();
            sendQueue.offer(chunk);
            droppedChunks.incrementAndGet();
        }
    }

    private void startSender() {
        senderThread = new Thread(() -> {
            while (!stopRequested.get()) {
                try {
                    byte[] chunk = sendQueue.poll(200, TimeUnit.MILLISECONDS);
                    if (chunk == null) continue;
                    if (wsClient != null && wsClient.isOpen()) {
                        wsClient.send(chunk); // binary frames carry audio
                        sentChunks.incrementAndGet();
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    // FIX #8: do not terminate on a transient send failure.
                    // Original: the catch block called break on any exception, so a single
                    // WebsocketNotConnectedException permanently stopped transmission while the
                    // process continued running and produced no further output. The close
                    // handler now determines when the session ends.
                    if (!stopRequested.get()) {
                        System.err.println("Send error (continuing): " + e);
                    }
                }
            }
        }, "aai-sender");

        senderThread.setDaemon(true);
        senderThread.start();
    }

    // ---------------------------------------------------------------------------------
    // Shutdown
    // ---------------------------------------------------------------------------------

    private void cleanup() {
        if (!cleanedUp.compareAndSet(false, true)) return; // FIX #21

        stopRequested.set(true);
        isRecording.set(false);

        // FIX #20: stop the capture thread and join it before closing the line.
        // Original: cleanup() closed the microphone while the capture thread was blocked inside
        // microphone.read(), which raised an exception on every normal exit.
        joinQuietly(captureThread, 2000);

        if (microphone != null) {
            if (microphone.isActive()) microphone.stop();
            microphone.close();
        }

        // Transmit any audio still queued before requesting termination, so the end of the
        // final sentence is not lost.
        try {
            long deadline = System.currentTimeMillis() + 2000;
            while (!sendQueue.isEmpty() && System.currentTimeMillis() < deadline
                    && wsClient != null && wsClient.isOpen()) {
                byte[] chunk = sendQueue.poll();
                if (chunk != null) wsClient.send(chunk);
            }
        } catch (Exception ignored) {
            // best effort
        }

        if (wsClient != null && wsClient.isOpen()) {
            try {
                JsonObject terminateMsg = new JsonObject();
                terminateMsg.addProperty("type", "Terminate");
                wsClient.send(gson.toJson(terminateMsg));

                // FIX #15: wait for the server's Termination message.
                // Original: Thread.sleep(500) followed by closeBlocking(). The Terminate message
                // causes the server to flush the open turn, and a fixed delay does not reliably
                // allow that flush to complete. The Termination message also reports the billed
                // session duration.
                if (!terminationReceived.await(TERMINATION_WAIT_MS, TimeUnit.MILLISECONDS)) {
                    System.err.println("No Termination message within "
                            + TERMINATION_WAIT_MS + " ms; closing anyway.");
                }
                wsClient.closeBlocking();
            } catch (Exception e) {
                System.err.println("Error closing WebSocket: " + e);
            }
        }

        senderThread = null;
        if (recorder != null) recorder.close();

        System.out.printf("Session %s: chunks sent=%d, dropped=%d%n",
                sessionId, sentChunks.get(), droppedChunks.get());
        System.out.println("Cleanup complete.");
    }

    // ---------------------------------------------------------------------------------
    // WebSocket client
    // ---------------------------------------------------------------------------------

    private class AssemblyAIWebSocketClient extends WebSocketClient {

        AssemblyAIWebSocketClient(URI serverUri, Map<String, String> headers) {
            super(serverUri, headers);
        }

        @Override
        public void onOpen(ServerHandshake handshake) {
            System.out.println("WebSocket open (HTTP " + handshake.getHttpStatus() + ").");
            startAudioStreaming();
        }

        @Override
        public void onMessage(String message) {
            try {
                JsonObject data = gson.fromJson(message, JsonObject.class);

                // FIX #10: check for the type field before reading it.
                // Original: data.get("type").getAsString() with no guard. A message without a
                // type field raises NullPointerException, and the catch block printed
                // e.getMessage(), which is null for an NPE. The operator saw the text
                // "Error handling message: null" with no further detail. The raw payload is now
                // logged so that server responses remain readable.
                if (data == null || !data.has("type")) {
                    System.err.println("Message without type: " + message);
                    return;
                }

                switch (data.get("type").getAsString()) {
                    case "Begin"           -> handleBegin(data);
                    case "Turn"            -> handleTurn(data);
                    case "Termination"     -> handleTermination(data);
                    case "SpeakerRevision" -> handleSpeakerRevision(data);
                    // FIX #11: log unrecognised message types.
                    // Original: default: break; discarded every message type the client did not
                    // anticipate, including server diagnostics. Logging them preserves that
                    // information and keeps the client forward compatible.
                    default -> System.out.println("[" + data.get("type").getAsString() + "] " + message);
                }
            } catch (Exception e) {
                System.err.println("Error handling message: " + e + " | raw=" + message);
            }
        }

        private void handleBegin(JsonObject data) {
            sessionId = data.has("id") ? data.get("id").getAsString() : "unknown";
            String expires = data.has("expires_at")
                    ? DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
                        .withZone(ZoneId.systemDefault())
                        .format(Instant.ofEpochSecond(data.get("expires_at").getAsLong()))
                    : "n/a";

            System.out.printf("%nSession began: id=%s expiresAt=%s%n", sessionId, expires);

            // FIX #23: log the configuration the server applied.
            // The Begin message returns the settings actually in effect for the session.
            // Comparing these against the requested parameters detects a wrong or defaulted
            // model within the first message. Logging this in the original would have made the
            // model problem in FIX #4 visible on the first test run.
            if (data.has("configuration")) {
                System.out.println("Server-applied configuration: " + data.get("configuration"));
            }
        }

        private void handleTurn(JsonObject data) {
            String transcript = data.has("transcript") ? data.get("transcript").getAsString() : "";
            if (transcript.isEmpty()) return;

            // FIX #12: use end_of_turn rather than turn_is_formatted to detect a final result.
            // Original: the print logic branched on turn_is_formatted. That field is deprecated
            // on universal-3-5-pro, where formatting is always applied, so it is not a reliable
            // indicator of finality. end_of_turn is the correct signal.
            boolean endOfTurn = data.has("end_of_turn") && data.get("end_of_turn").getAsBoolean();

            String speaker = data.has("speaker_label")
                    ? data.get("speaker_label").getAsString() + ": " : "";
            String lang = data.has("language_code")
                    ? " [" + data.get("language_code").getAsString() + "]" : "";

            if (endOfTurn) {
                System.out.print("\r" + " ".repeat(100) + "\r");
                System.out.println(speaker + transcript + lang);
            } else {
                // Each partial result replaces the previous partial for the same turn.
                // Partials must not be concatenated.
                System.out.print("\r" + speaker + transcript);
            }
        }

        private void handleSpeakerRevision(JsonObject data) {
            // When speaker_labels is enabled, the server revises earlier speaker assignments as
            // it collects more audio. Store turns by turn_order and apply these revisions so
            // that speaker attribution in the final record is accurate.
            System.out.println("\n[SpeakerRevision] " + data);
        }

        private void handleTermination(JsonObject data) {
            double audio = data.has("audio_duration_seconds")
                    ? data.get("audio_duration_seconds").getAsDouble() : 0.0;
            double session = data.has("session_duration_seconds")
                    ? data.get("session_duration_seconds").getAsDouble() : 0.0;
            System.out.printf("%nTerminated: audio=%.2fs session=%.2fs (billing uses session)%n",
                    audio, session);
            terminationReceived.countDown(); // FIX #15
        }

        @Override
        public void onClose(int code, String reason, boolean remote) {
            // FIX #14: translate the close code into a description.
            // Original: the code was printed as a bare integer. The server returns specific
            // codes and reason strings for these failures, and two of the three blockers in
            // this file produce one. Without a description the information was not usable.
            System.out.printf("%nWebSocket closed: code=%d remote=%s reason=%s%n    %s%n",
                    code, remote, reason, explainCloseCode(code));
            stopRequested.set(true);
            terminationReceived.countDown();
            finished.countDown(); // FIX #9: release main(); the original blocked here
        }

        @Override
        public void onError(Exception ex) {
            System.err.println("\nWebSocket error: " + ex);
            stopRequested.set(true);
            finished.countDown(); // FIX #9
        }
    }

    /** FIX #14: documented v3 session close codes. */
    private static String explainCloseCode(int code) {
        return switch (code) {
            case 1000 -> "Normal closure.";
            case 1008 -> "Unauthorized. Missing or invalid Authorization header, or an account "
                       + "problem such as a disabled account or insufficient balance.";
            case 1011 -> "Server-side internal error. Retry with backoff and escalate if it "
                       + "persists.";
            case 3005 -> "Session cancelled. Generic server error. Retry with backoff.";
            case 3006 -> "Invalid message, invalid JSON, or termination due to inactivity. Send "
                       + "KeepAlive messages during extended silence.";
            case 3007 -> "Input duration violation. An audio chunk was outside the 50 to 1000 ms "
                       + "range, or audio was sent faster than real time. This is the code "
                       + "produced by the original 25 ms chunks.";
            case 3008 -> "Session expired. The three-hour maximum session duration was exceeded. "
                       + "Long proceedings require session rollover. See 03-scaling-to-2000.md.";
            case 3009 -> "Too many concurrent sessions. The new-session rate limit was exceeded. "
                       + "Retry with exponential backoff and jitter.";
            default   -> "Unmapped code. See the AssemblyAI streaming session error reference.";
        };
    }

    // ---------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------

    /**
     * FIX #13: constant-memory WAV writer.
     *
     * Writes a placeholder 44-byte header, appends PCM data as it is captured, then rewrites
     * the two size fields when the file is closed. Replaces the original List<byte[]> that
     * retained the entire recording in memory.
     */
    private static final class WavRecorder implements Closeable {
        private final RandomAccessFile raf;
        private final int sampleRate, channels, bitsPerSample;
        private long dataBytes = 0;
        private boolean closed = false;

        WavRecorder(String filename, int sampleRate, int channels, int bitsPerSample)
                throws IOException {
            this.sampleRate = sampleRate;
            this.channels = channels;
            this.bitsPerSample = bitsPerSample;
            this.raf = new RandomAccessFile(filename, "rw");
            this.raf.setLength(0);
            this.raf.write(header(0)); // placeholder, rewritten on close
            System.out.println("Recording to: " + filename);
        }

        synchronized void write(byte[] pcm) throws IOException {
            raf.write(pcm);
            dataBytes += pcm.length;
        }

        @Override
        public synchronized void close() {
            if (closed) return;
            closed = true;
            try {
                raf.seek(0);
                raf.write(header((int) dataBytes));
                raf.close();
                System.out.printf("WAV finalized: %.2f seconds%n",
                        (double) dataBytes / (sampleRate * channels * (bitsPerSample / 8)));
            } catch (IOException e) {
                System.err.println("Error finalizing WAV: " + e);
            }
        }

        private byte[] header(int dataSize) {
            ByteBuffer b = ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            int bytesPerSample = bitsPerSample / 8;
            b.put("RIFF".getBytes(StandardCharsets.US_ASCII));
            b.putInt(36 + dataSize);
            b.put("WAVE".getBytes(StandardCharsets.US_ASCII));
            b.put("fmt ".getBytes(StandardCharsets.US_ASCII));
            b.putInt(16);
            b.putShort((short) 1); // PCM
            b.putShort((short) channels);
            b.putInt(sampleRate);
            b.putInt(sampleRate * channels * bytesPerSample);
            b.putShort((short) (channels * bytesPerSample));
            b.putShort((short) bitsPerSample);
            b.put("data".getBytes(StandardCharsets.US_ASCII));
            b.putInt(dataSize);
            return b.array();
        }
    }

    private static void joinQuietly(Thread t, long millis) {
        if (t == null || !t.isAlive()) return;
        try {
            t.join(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static String url(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    private static String getenvOrDefault(String key, String fallback) {
        String v = System.getenv(key);
        return (v == null || v.isBlank()) ? fallback : v;
    }
}
