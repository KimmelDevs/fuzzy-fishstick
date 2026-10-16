'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { blobToWav, downloadUrl, extFor, fmtTime, pickMime, stamp } from '../lib/audio';

export default function MicStudio() {
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [volume, setVolume] = useState(1);
  const [hear, setHear] = useState(true);
  const [echo, setEcho] = useState(false);
  const [noise, setNoise] = useState(false);
  const [agc, setAgc] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recordings, setRecordings] = useState([]);
  const [canPickOutput, setCanPickOutput] = useState(false);

  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const gainRef = useRef(null);
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

  const stopMic = useCallback(async () => {
    await stopRecording();
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    ctxRef.current?.close().catch(() => {});
    streamRef.current = null;
    ctxRef.current = null;
    gainRef.current = null;
    recDestRef.current = null;
    if (meterRef.current) meterRef.current.style.width = '0%';
    setLive(false);
  }, [stopRecording]);

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

        source.connect(monitor);
        monitor.connect(ctx.destination); // -> your earphones
        source.connect(analyser); // -> level meter
        source.connect(recDest); // -> recorder (raw mic, not affected by volume)

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
    [inputId, outputId, echo, noise, agc, hear, volume, refreshDevices]
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

  const onVolume = (v) => {
    setVolume(v);
    if (gainRef.current && hear) gainRef.current.gain.value = v;
  };

  const onHear = (h) => {
    setHear(h);
    if (gainRef.current) gainRef.current.gain.value = h ? volume : 0;
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
        <button className="btn big rec" onClick={recording ? stopRecording : startRecording} disabled={!live}>
          {recording ? `■ Stop (${fmtTime(elapsed)})` : '● Record'}
        </button>
      </div>

      <div className="meter" aria-label="Input level">
        <div ref={meterRef} className="meter-bar" />
      </div>

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
