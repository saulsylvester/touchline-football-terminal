import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { newPlaybackClock, playbackTransport, reconcilePlaybackSample, requestPlaybackSeek } from './playbackClock';

interface Player {
  getCurrentTime(): number; getPlayerState(): number; getPlaybackRate(): number;
  seekTo(time: number, allowSeekAhead: boolean): void; playVideo(): void; pauseVideo(): void;
  setPlaybackRate(rate: number): void; destroy(): void; getIframe(): HTMLIFrameElement;
}
declare global {
  interface Window {
    YT?: { Player: new (element: HTMLElement, options: Record<string, unknown>) => Player };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loader: Promise<void> | undefined;
function loadAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    let script = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    const timeout = setTimeout(() => fail(), 15000);
    const fail = () => {
      clearTimeout(timeout);
      script?.removeEventListener('error', fail);
      script?.remove();
      loader = undefined;
      reject(new Error('YouTube player API could not be loaded. You can use the manual replay clock.'));
    };
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      script?.removeEventListener('error', fail);
      try { prior?.(); } finally { resolve(); }
    };
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.addEventListener('error', fail, { once: true });
      document.head.append(script);
    } else script.addEventListener('error', fail, { once: true });
  });
  return loader;
}

export interface PlayerControls { seek(seconds: number): void; play(): void; pause(): void; rate(value: number): void; }
interface Props {
  videoId: string; initialTime: number; active?: boolean;
  onTime: (seconds: number, seek: boolean) => void;
  onPlaying: (playing: boolean) => void;
  onError: (message: string | null) => void;
}

export default forwardRef<PlayerControls, Props>(function YouTubePlayer({ videoId, initialTime, active = true, onTime, onPlaying, onError }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const callbacks = useRef({ onTime, onPlaying, onError });
  callbacks.current = { onTime, onPlaying, onError };
  const initial = useRef(initialTime); initial.current = initialTime;
  const target = useRef(initialTime);
  const clock = useRef(newPlaybackClock());
  const readyRef = useRef(false);
  const activeRef = useRef(active); activeRef.current = active;
  const preservingPausedSeek = useRef(false);
  const requestedPlaying = useRef(false);
  const requestedRate = useRef(1);
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      target.current = Math.max(0, seconds);
      preservingPausedSeek.current = !activeRef.current || !requestedPlaying.current;
      clock.current = requestPlaybackSeek(clock.current, target.current, performance.now(), true);
      callbacks.current.onTime(target.current, true);
      if (readyRef.current) {
        player.current?.seekTo(target.current, true);
        if (preservingPausedSeek.current) player.current?.pauseVideo();
      }
    },
    play() {
      if (!activeRef.current) return;
      requestedPlaying.current = true;
      preservingPausedSeek.current = false;
      if (readyRef.current) player.current?.playVideo();
    },
    pause() {
      requestedPlaying.current = false;
      preservingPausedSeek.current = true;
      if (readyRef.current) player.current?.pauseVideo();
    },
    rate(value) {
      if (!Number.isFinite(value) || value <= 0) return;
      requestedRate.current = value;
      if (readyRef.current) player.current?.setPlaybackRate(value);
    },
  }), []);

  useEffect(() => {
    if (!active) {
      requestedPlaying.current = false;
      preservingPausedSeek.current = true;
      if (readyRef.current) player.current?.pauseVideo();
      callbacks.current.onPlaying(false);
    }
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let instance: Player | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    readyRef.current = false;
    setReady(false);
    target.current = initial.current;
    clock.current = newPlaybackClock();
    const loadTimeout = setTimeout(() => {
      if (!cancelled && !readyRef.current) callbacks.current.onError('YouTube is taking longer than expected to load. You can use the manual replay clock.');
    }, 12000);
    loadAPI().then(() => {
      if (cancelled || !container.current) return;
      const mount = document.createElement('div');
      container.current.replaceChildren(mount);
      instance = new window.YT!.Player(mount, {
        videoId, host: 'https://www.youtube-nocookie.com',
        playerVars: { controls: 1, rel: 0, playsinline: 1, origin: window.location.origin, start: Math.floor(target.current) },
        events: {
          onReady: () => {
            if (cancelled || !instance) return;
            clearTimeout(loadTimeout);
            readyRef.current = true;
            setReady(true);
            callbacks.current.onError(null);
            instance.getIframe().setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
            preservingPausedSeek.current = !activeRef.current || !requestedPlaying.current;
            if (target.current > 0 || clock.current.pending) {
              // initialTime is already displayed by the parent, so loading the
              // iframe at that position must not clear its command/history.
              clock.current = requestPlaybackSeek(clock.current, target.current, performance.now(), clock.current.pending?.announced ?? true);
              instance.seekTo(target.current, true);
            }
            instance.setPlaybackRate(requestedRate.current);
            if (requestedPlaying.current && activeRef.current) instance.playVideo();
            else instance.pauseVideo();
          },
          onStateChange: (event: { data: number }) => {
            if (cancelled) return;
            const transport = playbackTransport(activeRef.current, requestedPlaying.current, preservingPausedSeek.current, event.data === 1);
            if (transport.pause) instance?.pauseVideo();
            if (transport.playing) requestedPlaying.current = true;
            else if (event.data === 0 || event.data === 2) {
              requestedPlaying.current = false;
              // Once PAUSED has actually been observed, a new iframe PLAYING
              // event can be a user's Play even if seek reconciliation waits.
              if (event.data === 2 || !clock.current.pending) preservingPausedSeek.current = false;
            }
            callbacks.current.onPlaying(transport.playing);
          },
          onAutoplayBlocked: () => {
            if (!cancelled) callbacks.current.onError('Your browser blocked scripted playback. Press Play inside the YouTube player.');
          },
          onError: (event: { data: number }) => {
            if (cancelled) return;
            const errors: Record<number, string> = {
              2: 'YouTube rejected the video identifier.', 5: 'YouTube could not play the video in this browser.',
              100: 'This video is unavailable.', 101: 'The uploader has disabled embedding.',
              150: 'The uploader has disabled embedding.', 153: 'YouTube requires a valid page origin/referrer.',
            };
            callbacks.current.onPlaying(false);
            callbacks.current.onError(`${errors[event.data] || 'YouTube playback failed.'} (code ${event.data})`);
          },
        },
      });
      player.current = instance;
      timer = setInterval(() => {
        if (cancelled || !instance || !readyRef.current) return;
        try {
          const playerState = instance.getPlayerState();
          const playing = playerState === 1;
          if (playerState === 2) preservingPausedSeek.current = false;
          const transport = playbackTransport(activeRef.current, requestedPlaying.current, preservingPausedSeek.current, playing);
          if (transport.pause) instance.pauseVideo();
          callbacks.current.onPlaying(transport.playing);
          const next = reconcilePlaybackSample(clock.current, {
            time: instance.getCurrentTime(), wallTime: performance.now(), rate: instance.getPlaybackRate(), playing,
          });
          clock.current = next.clock;
          if (!playing && !next.clock.pending) preservingPausedSeek.current = false;
          if (next.seekStatus === 'failed') callbacks.current.onError('The player did not reach the requested seek. Restored the actual video position.');
          if (next.update) callbacks.current.onTime(next.update.time, next.update.seek);
        } catch { /* The API can briefly be unavailable during player transitions. */ }
      }, 250);
    }).catch((error: Error) => { if (!cancelled) callbacks.current.onError(error.message); });
    return () => {
      cancelled = true;
      clearTimeout(loadTimeout);
      if (timer) clearInterval(timer);
      try { instance?.destroy(); } catch { /* A partially initialised iframe can already be detached. */ }
      if (player.current === instance) player.current = null;
      readyRef.current = false;
    };
  }, [videoId]);

  return <div className="player-shell"><div className="youtube-mount" ref={container} />{!ready && <div className="player-loading"><span className="loader" />Loading official YouTube player<span className="muted">Dummy prices are already ready</span></div>}</div>;
});
