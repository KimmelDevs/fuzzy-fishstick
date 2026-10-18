'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { blobToWav, downloadUrl, extFor, fmtTime, makeImpulse, pickMime, stamp } from '../lib/audio';

export default function MicStudio() {
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [volume, setVolume] = useState(1);
  const [micBoost, setMicBoost] = useState(1);
  const [reverb, setReverb] = useState(63); // defaults match the StarMaker "Custom" effect
  const [roomSize, setRoomSize] = useState(64);
  const [hear, setHear] = useState(true);
  const [echo, setEcho] = useState(false);
  const [noise, setNoise] = useState(false);
  const [agc, setAgc] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordings, setRecordings] = useState([]);
  const [canPickOutput, setCanPickOutput] = useState(false);
  const [trackName, setTrackName] = useState('');
  const [trackLoading, setTrackLoading] = useState(false);
  const [musicVolume, setMusicVolume] = useState(0.8);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [musicWithRec, setMusicWithRec] = useState(true);
  const [mixMusic, setMixMusic] = useState(true);
  const [guideName, setGuideName] = useState('');
  const [useGuide, setUseGuide] = useState(true);
  const guideOn = useGuide && !!guideName;

  const ctxRef = useRef(null);
  const trackRef = useRef(null); // decoded AudioBuffer of the backing track
  const guideRef = useRef(null); // decoded AudioBuffer of the guide (e.g. the song with vocals)
  const musicSrcRef = useRef(null);
  const guideSrcRef = useRef(null);
  const musicGainRef = useRef(null);
  const trackToEarRef = useRef(null);
  const guideGainRef = useRef(null);
  const musicToRecRef = useRef(null);
  const streamRef = useRef(null);
  const gainRef = useRef(null);
  const micGainRef = useRef(null);
  const reverbRef = useRef(null); // ConvolverNode
  const reverbWetRef = useRef(null);
  const recDestRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const rafRef = useRef(null);
  const meterRef = useRef(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    setInputs(list.filter((d) => d.kind === 'audioinput'));
    setOutputs(list.filter((d) => d.kind === 'audiooutput'));
  }, []);

  useEffect(() => {
    setCanPickOutput(
      typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
    );
    refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
  }, [refreshDevices]);

  // kind is 'track' (what gets recorded) or 'guide' (what you hear instead, if set).
  const loadAudio = useCallback(async (kind, getData, name) => {
    setTrackLoading(true);
    setError('');
    const ctx = new AudioContext();
    try {
      const buffer = await ctx.decodeAudioData(await getData());
      if (kind === 'guide') {
        guideRef.current = buffer;
        setGuideName(name);
      } else {
        trackRef.current = buffer;
        setTrackName(name);
      }
    } catch {
      setError(`Could not load "${name}" as audio.`);
    } finally {
      ctx.close();
      setTrackLoading(false);
    }
  }, []);

  // Start with the bundled song: hear the full version, record over the instrumental.
  useEffect(() => {
    const get = (url) => () => fetch(url).then((r) => r.arrayBuffer());
    loadAudio('track', get('/tracks/heart-in-bloom-instrumental.mp3'), 'Heart In Bloom (Instrumental)');
    loadAudio('guide', get('/tracks/heart-in-bloom.mp3'), 'Heart In Bloom');
  }, [loadAudio]);

  // Earphones get either the guide or the backing track; the recorder always gets the backing track.
  const applyMusicGains = (vol, guideOn) => {
    if (musicGainRef.current) musicGainRef.current.gain.value = vol;
    if (trackToEarRef.current) trackToEarRef.current.gain.value = guideOn ? 0 : 1;
    if (guideGainRef.current) guideGainRef.current.gain.value = guideOn ? vol : 0;
  };

  const stopMusic = useCallback(() => {
    const srcs = [musicSrcRef.current, guideSrcRef.current];
    musicSrcRef.current = null; // mark as a manual stop so onended ignores it
    guideSrcRef.current = null;
    srcs.forEach((src) => {
      try {
        src?.stop();
      } catch {
        /* already stopped */
      }
    });
    setMusicPlaying(false);
  }, []);

  const stopRecording = useCallback(
    () =>
      new Promise((resolve) => {
        const rec = recorderRef.current;
        if (!rec || rec.state === 'inactive') return resolve();
        rec.addEventListener('stop', () => resolve(), { once: true });
        rec.stop();
      }),
    []
  );

  const playMusic = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || !trackRef.current) return;
    stopMusic();
    const at = ctx.currentTime + 0.05; // start both versions on the same sample
    const src = ctx.createBufferSource();
    src.buffer = trackRef.current;
    src.connect(musicGainRef.current);
    src.onended = () => {
      if (musicSrcRef.current !== src) return;
      // The song finished on its own: end the take with it.
      stopMusic();
      stopRecording();
    };
    src.start(at);
    musicSrcRef.current = src;
    if (guideRef.current) {
      const guide = ctx.createBufferSource();
      guide.buffer = guideRef.current;
      guide.connect(guideGainRef.current);
      guide.start(at);
      guideSrcRef.current = guide;
    }
    setMusicPlaying(true);
  }, [stopMusic, stopRecording]);

  const stopMic = useCallback(async () => {
    stopMusic();
    await stopRecording();
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    streamRef.current = null;
    ctxRef.current = null;
    gainRef.current = null;
    micGainRef.current = null;
    reverbRef.current = null;
    reverbWetRef.current = null;
    recDestRef.current = null;
    if (meterRef.current) meterRef.current.style.width = '0%';
    musicGainRef.current = null;
    trackToEarRef.current = null;
    guideGainRef.current = null;
    musicToRecRef.current = null;
    setLive(false);
  }, [stopRecording, stopMusic]);

  // Clean up if the page is closed or navigated away.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  const startMic = useCallback(
    async (overrides = {}) => {
      const inId = overrides.inputId ?? inputId;
      setError('');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: inId ? { exact: inId } : undefined,
            echoCancellation: echo,
            noiseSuppression: noise,
            autoGainControl: agc,
          },
        });

        const ctx = new AudioContext({ latencyHint: 'interactive' });
        if (outputId && typeof ctx.setSinkId === 'function') {
          try {
            await ctx.setSinkId(outputId);
          } catch {
            /* fall back to default output */
          }
        }
        if (ctx.state === 'suspended') await ctx.resume();

        const source = ctx.createMediaStreamSource(stream);
        const monitor = ctx.createGain();
        monitor.gain.value = hear ? volume : 0;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const recDest = ctx.createMediaStreamDestination();

        // Mic volume boosts the voice everywhere; the limiter keeps loud peaks from clipping.
        const micGain = ctx.createGain();
        micGain.gain.value = micBoost;
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -3;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        source.connect(micGain).connect(limiter);

        // Reverb: the dry voice plus a convolved "room" copy mixed in by the Reverb amount.
        const voice = ctx.createGain();
        const convolver = ctx.createConvolver();
        convolver.buffer = makeImpulse(ctx, roomSize);
        const wet = ctx.createGain();
        wet.gain.value = reverb / 100;
        limiter.connect(voice);
        limiter.connect(convolver).connect(wet).connect(voice);

        voice.connect(monitor);
        monitor.connect(ctx.destination); // -> your earphones
        limiter.connect(analyser); // -> level meter (dry, so it shows your real level)
        voice.connect(recDest); // -> recorder (mic volume and reverb apply, earphone volume doesn't)
        micGainRef.current = micGain;
        reverbRef.current = convolver;
        reverbWetRef.current = wet;

        const musicGain = ctx.createGain();
        const trackToEar = ctx.createGain();
        const guideGain = ctx.createGain();
        const musicToRec = ctx.createGain();
        musicToRec.gain.value = mixMusic ? 1 : 0;
        musicGain.connect(trackToEar).connect(ctx.destination); // backing track -> your earphones (unless the guide is on)
        musicGain.connect(musicToRec).connect(recDest); // backing track -> recorder, if mixing it in
        guideGain.connect(ctx.destination); // guide -> your earphones only, never recorded
        musicGainRef.current = musicGain;
        trackToEarRef.current = trackToEar;
        guideGainRef.current = guideGain;
        musicToRecRef.current = musicToRec;
        applyMusicGains(musicVolume, guideOn);

        ctxRef.current = ctx;
        streamRef.current = stream;
        gainRef.current = monitor;
        recDestRef.current = recDest;

        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const v = Math.abs(data[i] - 128) / 128;
            if (v > peak) peak = v;
          }
          if (meterRef.current) meterRef.current.style.width = `${Math.min(100, peak * 140)}%`;
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();

        setLive(true);
        await refreshDevices(); // device names are only available after permission
      } catch (e) {
        if (e.name === 'NotAllowedError') setError('Microphone permission was denied. Allow it in your browser and try again.');
        else if (e.name === 'NotFoundError') setError('No microphone found.');
        else if (e.name === 'OverconstrainedError') setError('That microphone is not available any more. Pick another one.');
        else setError(e.message || 'Could not start the microphone.');
      }
    },
    [inputId, outputId, echo, noise, agc, hear, volume, micBoost, reverb, roomSize, musicVolume, mixMusic, guideOn, refreshDevices]
  );

  const toggleMic = () => (live ? stopMic() : startMic());

  const onInputChange = async (id) => {
    setInputId(id);
    if (live) {
      await stopMic();
      await startMic({ inputId: id });
    }
  };

  const onOutputChange = async (id) => {
    setOutputId(id);
    if (live && ctxRef.current?.setSinkId) {
      try {
        await ctxRef.current.setSinkId(id);
      } catch (e) {
        setError('Could not switch output: ' + e.message);
      }
    }
  };

  const onReverb = (v) => {
    setReverb(v);
    if (reverbWetRef.current) reverbWetRef.current.gain.value = v / 100;
  };

  const onRoomSize = (v) => {
    setRoomSize(v);
    const conv = reverbRef.current;
    if (conv) conv.buffer = makeImpulse(conv.context, v);
  };

  const onMicBoost = (v) => {
    setMicBoost(v);
    if (micGainRef.current) micGainRef.current.gain.value = v;
  };

  const onVolume = (v) => {
    setVolume(v);
    if (gainRef.current && hear) gainRef.current.gain.value = v;
  };

  const onHear = (h) => {
    setHear(h);
    if (gainRef.current) gainRef.current.gain.value = h ? volume : 0;
  };

  // Keep the live mix in step with the controls (and with the guide finishing loading).
  useEffect(() => {
    applyMusicGains(musicVolume, guideOn);
  }, [musicVolume, guideOn]);

  const onMixMusic = (m) => {
    setMixMusic(m);
    if (musicToRecRef.current) musicToRecRef.current.gain.value = m ? 1 : 0;
  };

  const onPickAudio = (kind, file) => {
    if (!file) return;
    stopMusic();
    if (kind === 'track') {
      // A new backing song no longer matches the old guide.
      guideRef.current = null;
      setGuideName('');
    }
    loadAudio(kind, () => file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
  };

  const finishTake = () => {
    stopMusic();
    stopRecording();
  };

  const startRecording = () => {
    if (!recDestRef.current) return;
    const mime = pickMime();
    const rec = new MediaRecorder(recDestRef.current.stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      clearInterval(timerRef.current);
      const type = rec.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type });
      const item = {
        id: crypto.randomUUID(),
        blob,
        type,
        url: URL.createObjectURL(blob),
        duration: (performance.now() - startedAtRef.current) / 1000,
        createdAt: new Date(),
      };
      setRecordings((prev) => [item, ...prev]);
      setRecording(false);
    };
    rec.start(250);
    recorderRef.current = rec;
    if (musicWithRec && trackRef.current) playMusic(); // song starts from the top with the take
    startedAtRef.current = performance.now();
    setElapsed(0);
    timerRef.current = setInterval(
      () => setElapsed((performance.now() - startedAtRef.current) / 1000),
      200
    );
    setRecording(true);
  };

  const deleteRecording = (item) => {
    URL.revokeObjectURL(item.url);
    setRecordings((prev) => prev.filter((r) => r.id !== item.id));
  };

  const downloadWav = async (item) => {
    try {
      const wav = await blobToWav(item.blob);
      const url = URL.createObjectURL(wav);
      downloadUrl(url, `recording-${stamp(item.createdAt)}.wav`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError('Could not convert that recording to WAV.');
    }
  };

  const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;

  return (
    <div className="card">
      <header className="head">
        <h1>🎙️ Mic Studio</h1>
        <span className={`pill ${live ? 'on' : ''}`}>{live ? 'Mic on' : 'Mic off'}</span>
      </header>

      <p className="warn">🎧 Wear earphones. With speakers, your mic will pick up the sound and squeal.</p>

      <div className="row">
        <button className={`btn big ${live ? 'stop' : 'go'}`} onClick={toggleMic}>
          {live ? 'Stop microphone' : 'Start microphone'}
        </button>
        <button className="btn big rec" onClick={recording ? finishTake : startRecording} disabled={!live}>
          {recording ? `■ Stop (${fmtTime(elapsed)})` : '● Record'}
        </button>
      </div>

      <div className="meter" aria-label="Input level">
        <div ref={meterRef} className="meter-bar" />
      </div>

      <section className="track">
        <div className="track-head">
          <span>🎵 Backing track (recorded)</span>
          <strong>{trackLoading ? 'Loading…' : trackName || 'None'}</strong>
        </div>
        <div className="track-head">
          <span>🎧 In my earphones</span>
          <strong>{trackLoading ? 'Loading…' : (guideOn ? guideName : trackName) || 'None'}</strong>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={musicPlaying ? stopMusic : playMusic}
            disabled={!live || !trackName || trackLoading || recording}
          >
            {musicPlaying ? '■ Stop music' : '▶ Play music'}
          </button>
          {[
            ['track', 'Choose backing song…'],
            ['guide', 'Choose earphone song…'],
          ].map(([kind, text]) => (
            <label key={kind} className={`btn ${recording || trackLoading ? 'disabled' : ''}`}>
              {text}
              <input
                type="file"
                accept="audio/*"
                hidden
                disabled={recording || trackLoading}
                onChange={(e) => {
                  onPickAudio(kind, e.target.files[0]);
                  e.target.value = '';
                }}
              />
            </label>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={useGuide}
            disabled={!guideName}
            onChange={(e) => setUseGuide(e.target.checked)}
          />
          Hear the full song (with vocals) in my earphones, but record only the backing track
        </label>
        <label className="field">
          <span>Music volume: {Math.round(musicVolume * 100)}%</span>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.05"
            value={musicVolume}
            onChange={(e) => setMusicVolume(parseFloat(e.target.value))}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={musicWithRec} onChange={(e) => setMusicWithRec(e.target.checked)} />
          Start the song when I hit Record (recording stops when it ends)
        </label>
        <label className="check">
          <input type="checkbox" checked={mixMusic} onChange={(e) => onMixMusic(e.target.checked)} />
          Put the backing track in the recording (off = just my voice)
        </label>
        {!live && <small className="muted">Start the microphone to play the music.</small>}
      </section>

      <label className="field">
        <span>Microphone</span>
        <select value={inputId} onChange={(e) => onInputChange(e.target.value)} disabled={recording}>
          <option value="">System default</option>
          {inputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {label(d, i, 'Microphone')}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Earphones / output</span>
        <select
          value={outputId}
          onChange={(e) => onOutputChange(e.target.value)}
          disabled={!canPickOutput}
        >
          <option value="">System default</option>
          {outputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {label(d, i, 'Output')}
            </option>
          ))}
        </select>
        {!canPickOutput && (
          <small>Your browser can&apos;t choose an output device. Set it in your system sound settings (or use Chrome/Edge).</small>
        )}
      </label>

      <label className="field">
        <span>Mic volume: {Math.round(micBoost * 100)}%</span>
        <input
          type="range"
          min="0"
          max="6"
          step="0.1"
          value={micBoost}
          onChange={(e) => onMicBoost(parseFloat(e.target.value))}
        />
        <small>Boosts your voice in the recording and in your earphones. Aim for the meter to reach yellow when you sing loudly.</small>
      </label>

      <section className="track">
        <div className="track-head">
          <span>✨ Voice effect: reverb</span>
          <button
            className="btn"
            onClick={() => {
              onReverb(63);
              onRoomSize(64);
            }}
          >
            StarMaker Custom
          </button>
        </div>
        {[
          ['Reverb', reverb, onReverb],
          ['Room size', roomSize, onRoomSize],
        ].map(([name, value, onChange]) => (
          <label key={name} className="field">
            <span>
              {name}: {value}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={value}
              onChange={(e) => onChange(parseInt(e.target.value, 10))}
            />
          </label>
        ))}
        <small className="muted">Set Reverb to 0 for your dry voice. You hear the effect live and it&apos;s saved in the recording.</small>
      </section>

      <label className="field">
        <span>Volume in earphones: {Math.round(volume * 100)}%</span>
        <input
          type="range"
          min="0"
          max="3"
          step="0.05"
          value={volume}
          onChange={(e) => onVolume(parseFloat(e.target.value))}
        />
      </label>

      <label className="check">
        <input type="checkbox" checked={hear} onChange={(e) => onHear(e.target.checked)} />
        Hear myself (turn off to record silently)
      </label>

      <details>
        <summary>Audio processing {live && '(stop the mic to change)'}</summary>
        <label className="check">
          <input type="checkbox" checked={echo} disabled={live} onChange={(e) => setEcho(e.target.checked)} />
          Echo cancellation
        </label>
        <label className="check">
          <input type="checkbox" checked={noise} disabled={live} onChange={(e) => setNoise(e.target.checked)} />
          Noise suppression
        </label>
        <label className="check">
          <input type="checkbox" checked={agc} disabled={live} onChange={(e) => setAgc(e.target.checked)} />
          Auto gain control
        </label>
      </details>

      {error && <p className="error">{error}</p>}

      <h2>Recordings</h2>
      {recordings.length === 0 && <p className="muted">Nothing recorded yet. Start the mic, then hit Record.</p>}
      <ul className="list">
        {recordings.map((r) => (
          <li key={r.id} className="rec-item">
            <div className="rec-top">
              <strong>{r.createdAt.toLocaleTimeString()}</strong>
              <span className="muted">{fmtTime(r.duration)}</span>
            </div>
            <audio controls src={r.url} preload="metadata" />
            <div className="row small">
              <button className="btn" onClick={() => downloadUrl(r.url, `recording-${stamp(r.createdAt)}.${extFor(r.type)}`)}>
                Download .{extFor(r.type)}
              </button>
              <button className="btn" onClick={() => downloadWav(r)}>Download .wav</button>
              <button className="btn danger" onClick={() => deleteRecording(r)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted">Recordings stay in this tab only. Download what you want to keep.</p>
    </div>
  );
}
