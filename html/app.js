import {check} from './lib.js';

import {ServerConnection, FakeServerConnection} from './net.js';
import {AudioChunk, CompressedAudioChunk, PlaceholderChunk, concat_chunks, ClockInterval, ClientClockReference, ServerClockReference} from './audiochunk.js';

// Work around some issues related to caching and error reporting
//   by forcing this to load up top, before we try to 'addModule' it.
import './audio-worklet.js';

// We fall back exponentially until we find a good size, but we need a
// place to start that should be reasonably fair.
const INITIAL_MS_PER_BATCH = 600; // XXX 180;  // XXX: probably make sure this is a multiple of our opus frame size (60ms), but it should in theory work without
// If we have fallen back so much that we are now taking this long,
// then give up and let the user know things are broken.
const MAX_MS_PER_BATCH = 900;

// this must be 2.5, 5, 10, 20, 40, or 60.
const OPUS_FRAME_MS = 60;

function close_stream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}


// Will optimistically request mic permissions as soon as it's constructed, but will not actually enumerate mics until asked for them.
export class MicEnumerator {
  async force_permission_prompt() {
    // In order to enumerate devices, we must first force a permission prompt by opening a device and then closing it again.
    // See: https://stackoverflow.com/questions/60297972/navigator-mediadevices-enumeratedevices-returns-empty-labels
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    close_stream(stream);
  }

  async wait_for_mic_permissions() {
    var perm_status = await navigator.permissions.query({name: "microphone"}).catch(() => null);
    if (!perm_status) {
      force_permission_prompt();
      return;
    }
    if (perm_status.state == "granted" || perm_status.state == "denied") {
      return;
    }
    force_permission_prompt();
    return new Promise((resolve, reject) => {
      perm_status.onchange = (e) => {
        if (e.target.state == "granted" || e.target.state == "denied") {
          resolve();
        }
      }
    });
  }

  constructor() {
    // Start the process but don't actually await since this is a constructor.
    this.wait_for_mic_permissions();
  }

  async mics() {
    try {
      await this.wait_for_mic_permissions();
      var devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      console.error("Failed to get mics:", e);
      return undefined;
    }
    return devices.filter(d => d.kind === 'audioinput');
  }
}

export var start_hooks = [];
export var stop_hooks = [];
export var event_hooks = [];
var alarms = {};
var alarms_fired = {};
var cur_clock_cbs = [];

export function declare_event(evid, offset) {
  cur_clock_cbs.push( (clock)=>{
    send_metadata.event_data ||= [];
    send_metadata.event_data.push(
      {evid,
       clock:clock-(offset||0)*audioCtx.sampleRate} // XXX
    );
  });
  playerNode.port.postMessage({
    type: "request_cur_clock"
  });
}

export async function openMic(deviceId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,  // Unfortunately this tends to kill long held notes, which is bad; but people's levels being wildly different is also bad. Manage it ourselves?
        deviceId: { exact: deviceId }
      }
    });
  } catch (e) {
    console.error("Unable to open specified mic device", deviceId);
    return undefined;
  }
}

// NOTE NOTE NOTE:
// * All `clock` variables are measured in samples.
// * All `clock` variables represent the END of an interval, NOT the
//   beginning. It's arbitrary which one to use, but you have to be
//   consistent, and trust me that it's slightly nicer this way.
var server_connection;
var loopback_mode;

var synthetic_audio_source;
var synthetic_click_interval;

// Used to coordinate changes to various parameters while messages may still be in flight.
//var epoch = 0;

class AudioEncoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.client_clock = null;
    this.server_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    var queue_entry = this.request_queue.shift();
    var response_id = ev.data.request_id;
    check(queue_entry[0] == response_id, "Responses out of order", queue_entry, ev.data);
    if (ev.data.status != 0) {
      throw new Error("AudioEncoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      // console.debug("VERYSPAM", "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with encoder.js
    })
    this.queued_chunk = null;
    return this.worker_rpc(cfg);
  }

  async encode_chunk(chunk) {
    chunk.check_clock_reference(this.client_clock_reference);
    check(this.client_clock === null || !(chunk instanceof PlaceholderChunk), "Can't send placeholder chunks once clock has started");

    if (this.queued_chunk !== null) {
      chunk = concat_chunks([this.queued_chunk, chunk]);
      this.queued_chunk = null;
    }

    if (chunk instanceof PlaceholderChunk) {
      var result_length = Math.round(chunk.length / this.client_clock_reference.sample_rate * this.server_clock_reference.sample_rate);
      var opus_samples = OPUS_FRAME_MS * this.server_clock_reference.sample_rate / 1000;
      var send_length = Math.round(result_length / opus_samples) * opus_samples;

      // This is ugly.
      var leftover_length = Math.round((result_length - send_length) * this.client_clock_reference.sample_rate / this.server_clock_reference.sample_rate);
      if (leftover_length > 0) {
        this.queued_chunk = new PlaceholderChunk({
          reference: this.client_clock_reference,
          length: leftover_length
        });
      }

      return new PlaceholderChunk({
        reference: this.server_clock_reference,
        length: send_length
      });
    }

    if (this.client_clock === null) {
      this.client_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.server_clock = Math.round(this.client_clock
        / this.client_clock_reference.sample_rate
        * this.server_clock_reference.sample_rate);
    }
    if (this.client_clock != chunk.start) {
      throw new Error("Cannot encode non-contiguous chunks!");
    }
    this.client_clock = chunk.end;

    var { packets, samples_encoded, buffered_samples } = await this.encode({
      samples: chunk.data
    });

    this.server_clock += samples_encoded
    // At this point server_clock is behind chunk.end by buffered_samples, the amount of stuff remaining buffered inside the encoder worker
    var server_clock_adjusted = this.server_clock + buffered_samples;
    var client_clock_hypothetical = server_clock_adjusted / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate;

    // XXX: we'll see about this? I believe as long as the resampler is buffering correctly, this should never exceed 1, and should not be subject to accumulated roundoff error.
    // NOTE: We have to use chunk.end here, and not this.client_clock, which may have moved on while we were waiting for the decoder.
    console.debug("SPAM", "net sample rate clock error:", chunk.end - client_clock_hypothetical);
    if (Math.abs(chunk.end - client_clock_hypothetical) > 5 /* arbitrary */) {
      console.warn("Sample rate clock slippage excessive in encoder; why is this happening?", chunk.end, client_clock_hypothetical, this.server_clock, buffered_samples, server_clock_adjusted, this.server_clock_reference.sample_rate, this.client_clock_reference.sample_rate);
      // TODO: Is this error always spurious? What should we do here, or how should we prevent it?
      // throw new Error("sample rate clock slippage excessive; what happened?");
    }

    var enc_buf = [];
    packets.forEach((packet) => {
      enc_buf.push(new Uint8Array(packet.data));
    });
    var outdata = pack_multi(enc_buf);

    var result_interval = new ClockInterval({
      reference: this.server_clock_reference,
      end: this.server_clock,
      length: samples_encoded
    });
    return new CompressedAudioChunk({
      interval: result_interval,
      data: outdata
    });
  }

  async encode(in_data) {
    var data = await this.worker_rpc(in_data);
    if (data.packets === undefined) {
      throw new Error("encode returned no packets:" + JSON.stringify(data));
    }
    return data;
  }

  // XXX: should probably drain the queue?
  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    return this.worker_rpc({
      reset: true
    });
  }
}

class AudioDecoder {
  constructor(path) {
    this.worker = new Worker(path);
    this.server_clock = null;
    this.client_clock = null;
    this.next_request_id = 0;
    this.request_queue = [];
    this.worker.onmessage = this.handle_message.bind(this);
  }

  handle_message(ev) {
    if (ev.data?.type === 'exception') {
      throw ev.data.exception;
    }
    var queue_entry = this.request_queue.shift();
    var response_id = ev.data.request_id;
    check(queue_entry[0] == response_id, "Responses out of order", queue_entry, ev.data);
    if (ev.data.status != 0) {
      throw new Error("AudioDecoder RPC failed: " + JSON.stringify(ev.data));
    }
    queue_entry[1](ev.data);
  }

  async worker_rpc(msg, transfer) {
    var request_id = this.next_request_id;
    var _this = this;
    this.next_request_id += 1;
    return new Promise(function (resolve, _) {
      _this.request_queue.push([request_id, resolve]);
      // console.debug("VERYSPAM", "Posting to port", _this.worker, "msg", msg, "transfer", transfer);
      _this.worker.postMessage({ request_id, ...msg }, transfer);
    });
  }

  // MUST be called before ANY other RPCs
  async setup(cfg) {
    this.client_clock_reference = new ClientClockReference({
      sample_rate: cfg.sampling_rate
    });
    this.server_clock_reference = new ServerClockReference({
      sample_rate: cfg.codec_sampling_rate || 48000  // keep in sync with decoder.js
    })
    return this.worker_rpc(cfg);
  }

  // XXX: should probably drain the queue?
  async reset() {
    this.client_clock = null;
    this.server_clock = null;
    return this.worker_rpc({
      reset: true
    });
  }

  async decode_chunk(chunk) {
    chunk.check_clock_reference(this.server_clock_reference);

    if (chunk instanceof PlaceholderChunk) {
      var result_interval = new ClockInterval({
        reference: this.client_clock_reference,
        length: Math.round(chunk.length / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
        end: Math.round(chunk.end / this.server_clock_reference.sample_rate * this.client_clock_reference.sample_rate),
      });
      // Wrap this in a promise so that it resolves asynchronously and does not return "too fast".
      // XXX doesn't help
      return Promise.resolve(new PlaceholderChunk({
        reference: result_interval.reference,
        length: result_interval.length,
        interval: result_interval
      }));
    }

    if (this.server_clock === null) {
      this.server_clock = chunk.start;

      // This isn't ideal, but the notion is that we only do this once, so there is no accumulating rounding error.
      this.client_clock = Math.round(this.server_clock
        / this.server_clock_reference.sample_rate
        * this.client_clock_reference.sample_rate);
    }
    if (this.server_clock != chunk.start) {
      throw new Error("Cannot decode non-contiguous chunks!");
    }
    this.server_clock = chunk.end;

    var indata = chunk.data;
    var packets = unpack_multi(indata);

    // Make all the calls FIRST, and THEN gather the results. This will prevent us from interleaving with other calls to decode_chunk. (Assuming certain things about in-order dispatch and delivery of postMessage, which I hope are true.)
    // console.debug("VERYSPAM", "Starting to decode sample packets", packets);
    var decoding_promises = [];
    for (var i = 0; i < packets.length; ++i) {
      decoding_promises.push(this.decode({
        data: packets[i].buffer
      }));
    }

    // console.debug("VERYSPAM", "Forcing decoding promises", decoding_promises);
    var decoded_packets = [];
    for (var i = 0; i < decoding_promises.length; ++i) {
      var p_samples = await decoding_promises[i];
      // console.debug("VERYSPAM", "Decoded samples:", p_samples);
      decoded_packets.push(new Float32Array(p_samples.samples));
    }

    var play_samples = concat_typed_arrays(decoded_packets, Float32Array);
    var decoded_length_expected = chunk.length / chunk.reference.sample_rate * this.client_clock_reference.sample_rate;
    // XXX: This is janky, in reality our chunk length divides evenly so it should be 0, if it doesn't I'm not sure what we should expect here?
    check(Math.abs(decoded_length_expected - play_samples.length) < 5, "Chunk decoded to wrong length!", chunk, play_samples);
    this.client_clock += play_samples.length;
    console.debug("SPAM", "Decoded all samples from server:", decoded_packets);

    var result_interval = new ClockInterval({
      reference: this.client_clock_reference,
      end: this.client_clock,
      length: play_samples.length
    });
    return new AudioChunk({
      interval: result_interval,
      data: play_samples
    });
  }

  async decode(packet) {
    return await this.worker_rpc(packet, [packet.data]);
  }
}

export class BucketBrigadeContext extends EventTarget {
  constructor(options) {
    var {micStream, apiUrl} = options;
    super();

    this.audioCtx = null;
    this.micNode = null;
    this.playerNode = null;
    this.encoder = null;
    this.decoder = null;
    this.encoding_latency_ms = null;
    this.micStream = micStream;
    this.apiUrl = apiUrl;
  }

  ms_to_samples(ms) {
    return this.audioCtx.sampleRate * ms / 1000;
  }

  samples_to_ms(samples) {
    return samples * 1000 / this.audioCtx.sampleRate;
  }

  ms_to_batch_size(ms) {
    return Math.round(this.ms_to_samples(ms) / 128);
  }

  batch_size_to_ms(batch_size) {
    return Math.round(this.samples_to_ms(batch_size * 128));
  }

  set_estimate_latency_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "latency_estimation_mode",
      "enabled": mode
    });
  }

  send_ignore_input(mode) {
    this.playerNode.port.postMessage({
      "type": "ignore_input",
      "enabled": mode
    });
  }

  set_estimate_volume_mode(mode) {
    this.playerNode.port.postMessage({
      "type": "volume_estimation_mode",
      "enabled": mode
    });
  }

  click_volume_change(click_volume) {
    this.playerNode.port.postMessage({
      "type": "click_volume_change",
      "value": click_volume,
    });
  }

  send_local_latency(local_latency_ms) {
    //var local_latency_ms = parseFloat(estLatency.innerText);

    // Account for the (small) amount of latency added by opus and the speex resampler.
    local_latency_ms += this.encoding_latency_ms;

    // Convert from ms to samples.
    var local_latency = Math.round(local_latency_ms * this.audioCtx.sampleRate / 1000); // XXX

    if (synthetic_audio_source !== null) {
      local_latency = 0;
    }
    this.playerNode.port.postMessage({
      "type": "local_latency",
      "local_latency": local_latency,
    });
  }

  samples_to_worklet(chunk) {
    var message = {
      type: "samples_in",
      chunk,
    };

    console.debug("SPAM", "Posting to worklet:", message);
    this.playerNode.port.postMessage(message);  // XXX huh, we aren't using transfer, and plausibly should be
  }

  handle_message_unstarted(e) {
    console.warn("message handler triggered before started:", e);
    return;
  }

  async start_bucket() {
    //switch_app_state(APP_STARTING);

    if (this.audioCtx) {
      throw new Error("NOT RUNNING, BUT ALREADY HAVE AUDIOCTX?");
      return;
    }

    // Do NOT set the sample rate to a fixed value. We MUST let the audioContext use
    // whatever it thinks the native sample rate is. This is becuse:
    // * Firefox does not have a resampler, so it will refuse to operate if we try
    //   to force a sample rate other than the native one
    // * Chrome does have a resampler, but it's buggy and has a habit of dropping
    //   frames of samples under load, which fucks everything up. (Note that even
    //   without resampling, Chrome still has a habit of dropping frames under
    //   load, but it happens a heck of a lot less often.)
    var AudioContext = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioContext({latencyHint: 'playback'});
    //sampleRate.value = this.audioCtx.sampleRate;
    console.debug("Audio Context:", this.audioCtx);

    // XXX: this all gets kind of gross with 44100, nothing divides nicely.
    // XXX: this should really be on the clients, not the context?
    this.sample_batch_size = this.ms_to_batch_size(INITIAL_MS_PER_BATCH);
    //window.msBatchSize.value = INITIAL_MS_PER_BATCH;

    console.debug("micStream is", this.micStream);
    this.micNode = new MediaStreamAudioSourceNode(this.audioCtx, { mediaStream: this.micStream });

    //XXX: the AudioWorkletProcessor just seems to get leaked here, every time we stop and restart. I'm not sure if there's a way to prevent that without reloading the page... (or avoiding reallocating it when we stop and start.)
    await this.audioCtx.audioWorklet.addModule('audio-worklet.js');
    this.playerNode = new AudioWorkletNode(this.audioCtx, 'player');

    // XXX: this encoder decoder crap should probably all live in the SingerClient?
    // Avoid starting more than one copy of the encoder/decoder workers.
    if (!this.encoder) {
      this.encoder = new AudioEncoder('worker-encoder.js');
      var enc_cfg = {
          sampling_rate: this.audioCtx.sampleRate,  // This instructs the encoder what sample rate we're giving it. If necessary (i.e. if not equal to 48000), it will resample.
          num_of_channels: 1,
          frame_duration: OPUS_FRAME_MS,
      };
      console.debug("Setting up opus encoder. Encoder params:", enc_cfg);
      var { status, resampling } = await this.encoder.setup(enc_cfg);
      if (status != 0) {
        throw new Error("Encoder setup failed");
      }

      /** ENCODING/DECODING LATENCY NOTES:
        * In most normal modes, Opus adds a total of 6.5ms across encoding and decoding.
          * (see https://en.wikipedia.org/wiki/Opus_(audio_format) .)

        * Resampler latency figures from https://lastique.github.io/src_test/
          * (https://web.archive.org/web/20200918060257/https://lastique.github.io/src_test/):
          * For quality 5 (we are here), 0.8 - 1ms.
          * For quality 10, 2.6 - 3ms.

        * We run the resampler in both direction (if the system is not 48k), giving about 8.3ms of
          total added latency. (We can count the encoding and decoding together, even though they
          happen separately, because latency coming or going has the same effect.)
          * This is low enough that we SHOULD be ok to ignore it, but we will add it in to be sure.
      */

      this.encoding_latency_ms = 6.5;  // rudely hardcoded opus latency
      if (resampling) {
        this.encoding_latency_ms += 1.8;
      }
    }
    this.encoder.reset();

    if (!this.decoder) {
      this.decoder = new AudioDecoder('worker-decoder.js')
      var dec_cfg = {
          sampling_rate: this.audioCtx.sampleRate,  // This instructs the decoder what sample rate we want from it. If necessary (i.e. if not equal to 48000), it will resample.
          num_of_channels: 1,
          // Frame duration will be derived from the encoded data.
      };
      console.debug("Setting up opus decder. Decoder params:", dec_cfg);
      await this.decoder.setup(dec_cfg);
    }
    this.decoder.reset();

    // The encoder stuff absolutely has to finish getting initialized before we start getting messages for it, or shit will get regrettably real. (It is designed in a non-threadsafe way, which is remarkable since javascript has no threads.)

    this.playerNode.port.onmessage = (e) => {
      this.handle_message_unstarted(e);
    }
    this.micNode.connect(this.playerNode);
    this.playerNode.connect(this.audioCtx.destination);

    // XXX: This is not great, becase it will start the AudioWorklet, which will immediately proceed to start sending us audio, which we aren't ready for yet because we're about to go into calibration mode. However if we get enough to try to send to the server at this point, the ServerConnection will discard it anyway, since it hasn't been started yet.
    await this.reload_settings();
  }

  // Should really be named "restart everything", which is what it does.
  async reload_settings(startup) {
    /* XXX
    console.info("Resetting the world! Old epoch was:", epoch);
    epoch +=1;
    console.info("New epoch is:", epoch);
    */

    // XXX: Not guaranteed to be immediate; we should wait for it to confirm.
    this.playerNode.port.postMessage({
      type: "stop"
    });

    //if (server_connection) {
    //  server_connection.stop();
    //  server_connection = null;
    //}

    console.info("Stopped audio worklet"); // and server connection.");

    //mic_buf = [];

/*
    loopback_mode = loopbackMode.value;

    if (loopback_mode == "none" || loopback_mode == "server") {
      server_connection = new ServerConnection({
        // Support relative paths
        target_url: new URL(serverPath.value, document.location),
        audio_offset_seconds: parseInt(audioOffset.value),
        userid: myUserid,
        epoch
      })
    } else {
      server_connection = new FakeServerConnection({
        sample_rate: 48000,
        epoch
      })
    }

    console.info("Created new server connection, resetting encoder and decoder.");
*/

    await this.encoder.reset();
    await this.decoder.reset();

    console.info("Reset encoder and decoder, starting audio worket again.");

    // Send this before we set audio params, which declares us to be ready for audio
    // XXX click_volume_change();
    var audio_params = {
      type: "audio_params",
      synthetic_source: synthetic_audio_source,
      click_interval: synthetic_click_interval,
      loopback_mode,
      epoch: 0, // XXX epoch no longer used?
    }
    // This will reset the audio worklett, flush its buffer, and start it up again.
    this.playerNode.port.postMessage(audio_params);

    alarms_fired = {};
    for (let hook of start_hooks) {
      hook();
    }
  }
}

export class SingerClient extends EventTarget {
  constructor(options) {
    var {context, secretId, speakerMuted, micMuted, extra} = options;
    // Stuff that probably doesn't go in the real API, and is subject to change or removal, but is useful for now
    // XXX: add loopback mode?
    var {userid, username, audio_offset_seconds} = extra;
    super();

    this.ctx = context;
    this.secretId = secretId;
    this.server_connection = new ServerConnection({
      target_url: new URL(this.ctx.apiUrl),
      audio_offset_seconds,
      userid,
      epoch: 0,  // XXX epoch no longer useful?
    });

    this.hasConnectivity = true;  // XXX public readonly

    // XXX ignoring speakermuted, micmuted?
    this.userid = userid;
    this.username = username;

    this.mic_buf = [];
    this.send_metadata = {};  // XXX: not sure why this is persistent
    // XXX: should probably have these on here instead of the context? Unless they leak stuff (do they?) and we don't want to recreate them.
    this.encoder = this.ctx.encoder;
    this.decoder = this.ctx.decoder;
    this.encoder.reset();
    this.decoder.reset();

    // XXX invasive coupling, use custom events on the context instead?
    this.ctx.playerNode.port.onmessage = (event) => {
      this.handle_message(event);
    }
  }

  async start_singing() {
    await this.server_connection.start();
  }

  async handle_message(event) {
    var msg = event.data;
    if (msg.type === "exception") {
      throw msg.exception;
    }
    if (msg.type === "underflow") {
      //window.lostConnectivity.style.display = "block";
      //await restart();
      // XXX: probably need to deal with this better, auto-restarting stuff
      throw new Error("Underflow in SingerClient handle_message");
      /* XXX: don't worry about this stuff for now
    } else if (msg.type == "alarm") {
      if ((msg.time in alarms) && ! (msg.time in alarms_fired)) {
        console.info("calling alarm at "+msg.time)
        alarms[msg.time]();
        alarms_fired[msg.time] = true;
      }
      return;
    } else if (msg.type == "cur_clock") {
      for (let cb of cur_clock_cbs) {
        cb(msg.clock);
        console.warn("got clock "+msg.clock+" and event_data is now "+ send_metadata.event_data);
      }
      cur_clock_cbs = [];
      return; */
    } else if (msg.type != "samples_out") {
      throw new Error("Got message of unknown type: " + JSON.stringify(msg));
    }

    // If we see this change at any point, that means stop what we're doing.
    //var our_epoch = epoch;

    console.debug("SPAM", "Got heard chunk:", msg);

    // Tricky metaprogramming bullshit to recover the object-nature of an object sent via postMessage
    var chunk = rebless(msg.chunk);
    this.mic_buf.push(chunk);

    // XXX: just for debugging
    // XXX: window.msWebAudioJankCurrent.value = Math.round(msg.jank) + "ms";

    if (this.mic_buf.length >= this.ctx.sample_batch_size) { //XXX sbs should be on clients not context right?
      var chunk = concat_chunks(this.mic_buf);
      console.debug("SPAM", "Encoding chunk to send:", chunk);
      this.mic_buf = [];

      var encoded_chunk = await this.encoder.encode_chunk(chunk);

      /*
      if (app_state != APP_RUNNING) {
        console.warn("Ending message handler early because not running");
        return;
      }
      if (our_epoch != epoch) {
        console.warn("Ending message handler early due to stale epoch");
        return;
      }
      */
      console.debug("SPAM", "Got encoded chunk to send:", encoded_chunk);

      this.send_metadata.username = this.username;
      // XXX send_metadata.loopback_mode = loopback_mode;
      this.server_connection.set_metadata(this.send_metadata);
      this.send_metadata = {}
      // XXX: interesting, it does not seem that these promises are guaranteed to resolve in order... and the worklet's buffer uses the first chunk's timestamp to decide where to start playing back, so if the first two chunks are swapped it has a big problem.
      const response = await this.server_connection.send(encoded_chunk);
      if (!response) {
        // XXX lost connectivity
        this.hasConnectivity = false;
        this.dispatchEvent(new Event("connectivityChange"));
        //window.lostConnectivity.style.display = "block";
        //await restart();
        return;
      }
      var { metadata, chunk: response_chunk, epoch: server_epoch } = response;
      if (!response_chunk) {
        return;
      }
      /*
      if (our_epoch != epoch) {
        console.warn("Ending message handler early due to stale epoch");
        return;
      }
      if (server_epoch != epoch) {
        console.warn("Ignoring message from server with old epoch");
        return;
      }
      if (app_state != APP_RUNNING) {
        console.warn("Ending message handler early because not running");
        return;
      }
      */

      //console.debug("SPAM", "Got chunk from server:", response_chunk.interval, response_chunk, metadata);
      var play_chunk = await this.decoder.decode_chunk(response_chunk);
      /*
      if (our_epoch != epoch) {
        console.warn("Ending message handler early due to stale epoch");
        return;
      }
      if (app_state != APP_RUNNING) {
        console.warn("Ending message handler early because not running");
        return;
      }
      */

      console.debug("SPAM", "Decoded chunk from server:", play_chunk.interval, play_chunk);
      // XXX invasive coupling
      this.ctx.samples_to_worklet(play_chunk);

      /*
      var queue_size = metadata["queue_size"];
      var user_summary = metadata["user_summary"] || [];
      var tracks = metadata["tracks"] || [];
      var chats = metadata["chats"] || [];
      var delay_seconds = metadata["delay_seconds"];
      var server_sample_rate = metadata["server_sample_rate"];
      var song_start_clock = metadata["song_start_clock"];
      var client_read_clock = metadata["client_read_clock"];
      var server_bpm = metadata["bpm"];
      var server_repeats = metadata["repeats"];
      var server_bpr = metadata["bpr"];
      var leader = metadata["leader"]

      for (let ev of metadata["events"]) {
        alarms[ev["clock"]] = () => event_hooks.map(f=>f(ev["evid"]));
        console.info(ev);
        playerNode.port.postMessage({
          type: "set_alarm",
          time: ev["clock"]
        });
      }

      // Defer touching the DOM, just to be safe.
      const connection_as_of_message = server_connection;
      requestAnimationFrame(() => {
        if (song_start_clock && song_start_clock > client_read_clock) {
          window.startSingingCountdown.style.display = "block";
          window.countdown.innerText = Math.round(
            (song_start_clock - client_read_clock) / server_sample_rate) + "s";
        } else {
          window.startSingingCountdown.style.display = "none";
        }


        if (delay_seconds) {
          if (delay_seconds > 0) {
            audioOffset.value = delay_seconds;
            // This will restart the world, so don't try to continue.
            audio_offset_change();
            return;
          }
        }

        // XXX: DOM stuff below this line.
        update_active_users(user_summary, server_sample_rate, leader);
        chats.forEach((msg) => receiveChatMessage(msg[0], msg[1]));
        update_backing_tracks(tracks);

        if (server_bpm) {
          window.bpm.value = server_bpm;
        }
        if (server_repeats) {
          window.repeats.value = server_repeats;
        }
        if (server_bpr) {
          window.bpr.value = server_bpr;
        }

        // This is how closely it's safe to follow behind us, if you get as unlucky as possible (and try to read _just_ before we write).
        clientReadSlippage.value = connection_as_of_message.client_window_time + play_chunk.length_seconds;
        // This is how far behind our target place in the audio stream we are. This must be added to the value above, to find out how closely it's safe to follow behind where we are _aiming_ to be. This value should be small and relatively stable, or something has gone wrong.
        clientReadSlippage.value = connection_as_of_message.clientReadSlippage;
      });
      */
    }
  }
}

// XXX missing close method
export class VolumeCalibrator extends EventTarget {
  constructor(options) {
    var {context} = options;
    super();

    this.ctx = context;
    this.hasMicInput = true;  // XXX should be readonly

    // XXX invasive coupling
    this.ctx.playerNode.port.onmessage = (event) => {
      this.handle_message(event);
    }

    // XXX etc.
    this.ctx.set_estimate_volume_mode(true);
  }

  handle_message(event) {
    var msg = event.data;
    if (msg.type === "exception") {
      throw msg.exception;
    }

    if (msg.type === "underflow") {
      throw new Error("Underflow in VolumeCalibrator handle_message");
    } else if (msg.type == "no_mic_input") {
      this.hasMicInput = false;
      this.dispatchEvent(new Event("micInputChange"));
      return;
    } else if (msg.type == "current_volume") {
      // Inverse of Math.exp(6.908 * linear_volume)/1000;
      const human_readable_volume = Math.log(msg.volume * 1000) / 6.908;
      this.dispatchEvent(new CustomEvent("volumeChange", {
        detail: {
          volume: human_readable_volume,
        }
      }))
          window.reportedVolume.innerText =
        Math.round(100*human_readable_volume)/100 + "dB";
      return;
    } else if (msg.type == "input_gain") {
      this.dispatchEvent(new CustomEvent("volumeCalibrated", {
        detail: {
          inputGain: msg.input_gain,
        }
      }));
      this.ctx.set_estimate_volume_mode(false);
      return;
    }
  }
}

export class LatencyCalibrator extends EventTarget {
  // XXX failed to define 'close()' yet
  constructor(options) {
    var {context, clickVolume} = options;
    super();

    this.ctx = context;
    this.click_volume_ = clickVolume;
    this.ctx.click_volume_change(this.click_volume_);
    this.hasMicInput = true;  // XXX should be readonly

    // XXX invasive coupling
    this.ctx.playerNode.port.onmessage = (event) => {
      this.handle_message(event);
    }

    // XXX: invasive coupling, and this maybe violates the desire to allow async construction of the context
    this.ctx.send_ignore_input(false);  // XXX: this actually appears to be ignored in this mode anyway
    this.ctx.set_estimate_latency_mode(true);
  }

  get clickVolume() {
    return this.click_volume_;
  }

  set clickVolume(new_volume) {
    this.click_volume_ = new_volume;
    this.ctx.click_volume_change(this.click_volume_);
  }

  handle_message(event) {
    var msg = event.data;
    if (msg.type === "exception") {
      throw msg.exception;
    }

    if (msg.type === "underflow") {
      throw new Error("Underflow in LatencyCalibrator handle_message");
    } else if (msg.type == "no_mic_input") {
      this.hasMicInput = false;
      this.dispatchEvent(new Event("micInputChange"));
      return;
    } else if (msg.type == "latency_estimate") {
      if (!this.hasMicInput) {
        this.hasMicInput = true;
        this.dispatchEvent(new Event("micInputChange"));
      }

      var beepDetails = {
        done: false,
        samples: msg.samples,
      }

      if (msg.p50 !== undefined) {
        console.debug("GOOD BEEP");
        const latency_range = msg.p75 - msg.p25;

        beepDetails.est25to75 = latency_range;
        beepDetails.estLatency = msg.p50;
        beepDetails.jank = msg.jank;

        if (msg.samples >= 7) {
          this.ctx.set_estimate_latency_mode(false);  // XXX invasive coupling
          beepDetails.done = true;

          if (latency_range <= 2) {
            beepDetails.success = true;
            // If we have measured latency within 2ms, that's good.
            this.ctx.send_local_latency(); // XXX invasive coupling
          } else {
            beepDetails.success = false;
          }
        }
      }
      var e = new CustomEvent("beep", {
        detail: beepDetails
      });
      this.dispatchEvent(e);
      return;
    }
  }
}

export function init_events() {
  let target_url = serverPath.value + "reset_events";
  let xhr = new XMLHttpRequest();
  xhr.open("POST", target_url, true);
  xhr.send();
}

// Pack multiple subpackets into an encoded blob to send the server
// - Packet count: 1 byte
// - Each packet:
//   - Packet length (bytes): 2 bytes, big endian
//   - Packet data
function pack_multi(packets) {
  console.debug("SPAM", "Encoding packet for transmission to server! input:", packets);
  var encoded_length = 1; // space for packet count
  packets.forEach((p) => {
    encoded_length += 2; // space for packet length
    encoded_length += p.length;
  });

  var outdata = new Uint8Array(encoded_length);
  outdata[0] = packets.length;
  var outdata_idx = 1;
  packets.forEach((p) => {
    if (p.constructor !== Uint8Array) {
      throw new Error("must be Uint8Array");
    }
    var len = p.length;  // will never exceed 2**16
    var len_b = [len >> 8, len % 256];
    outdata[outdata_idx] = len_b[0];
    outdata[outdata_idx + 1] = len_b[1];
    outdata.set(p, outdata_idx + 2);
    outdata_idx += len + 2;
  });
  console.debug("SPAM", "Encoded packet for transmission to server! Final outdata_idx:", outdata_idx, ", encoded_length:", encoded_length, ", num. subpackets:", packets.length, ", output:", outdata);
  return outdata;
}

function unpack_multi(data) {
  console.debug("SPAM", "Unpacking multi-packet from server, data:", data);
  if (data.constructor !== Uint8Array) {
    throw new Error("must be Uint8Array");
  }
  var packet_count = data[0];
  var data_idx = 1;
  var result = [];
  for (var i = 0; i < packet_count; ++i) {
    var len = (data[data_idx] << 8) + data[data_idx + 1];
    // console.debug("VERYSPAM", "Unpacking subpacket", i, "at offset", data_idx, "with len", len);
    var packet = new Uint8Array(len);
    data_idx += 2;
    packet.set(data.slice(data_idx, data_idx + len));
    data_idx += len;
    result.push(packet);
  }
  console.debug("SPAM", "Unpacked multi-packet from server! Final data_idx:", data_idx, ", total length:", data.length, ", num. subpackets:", packet_count, "final output:", result);
  return result;
}

function concat_typed_arrays(arrays, _constructor) {
  if (arrays.length == 0 && _constructor === undefined) {
    throw new Error("cannot concat zero arrays without constructor provided");
  }
  var constructor = _constructor || arrays[0].constructor;
  var total_len = 0;
  arrays.forEach((a) => {
    check(a.constructor === constructor, "must concat arrays of same type", a.constructor, constructor);
    total_len += a.length;
  });
  var result = new constructor(total_len);
  var result_idx = 0;
  arrays.forEach((a) => {
    result.set(a, result_idx);
    result_idx += a.length;
  });
  return result;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rebless(o) {
  if (o.type !== undefined) {
    Object.setPrototypeOf(o, eval(o.type).prototype);
  }
  if (o.rebless) {
    o.rebless();
  }
  return o;
}

