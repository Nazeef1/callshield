// CallShield — helpline calls between the caller page (phone) and the agent console (laptop).
// Signaling goes over /api/call/ws (see backend/calls.py); audio flows peer to peer over WebRTC.

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** Access code for the call socket: ?code= in the page URL (remembered), needed only if the server sets one. */
export function callCode() {
  let code = null;
  try { code = new URLSearchParams(location.search).get('code'); } catch { code = null; }
  try {
    if (code) localStorage.setItem('cs.callCode', code);
    else code = localStorage.getItem('cs.callCode');
  } catch { /* storage blocked */ }
  return code || '';
}

/**
 * Signaling socket with auto-reconnect.
 *   const s = callSocket('agent', { onMessage(msg), onState('connecting'|'open'|'closed'|'denied') });
 *   s.send({type: ...}); s.close();
 */
export function callSocket(role, { onMessage, onState } = {}) {
  let ws = null;
  let closed = false;
  let retry = 1000;
  let timer = null;
  const setState = (st) => { try { onState && onState(st); } catch (e) { console.error(e); } };

  function open() {
    if (closed) return;
    setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ role });
    const code = callCode();
    if (code) q.set('code', code);
    ws = new WebSocket(`${proto}://${location.host}/api/call/ws?${q}`);
    ws.onopen = () => { retry = 1000; setState('open'); };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { onMessage && onMessage(msg); } catch (e) { console.error('call message handler failed', e); }
    };
    ws.onclose = (ev) => {
      if (closed) return;
      if (ev.code === 4401) { setState('denied'); return; }
      setState('closed');
      clearTimeout(timer);
      timer = setTimeout(open, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  open();
  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
      return false;
    },
    get isOpen() { return !!ws && ws.readyState === WebSocket.OPEN; },
    close() { closed = true; clearTimeout(timer); if (ws) ws.close(); },
  };
}

/**
 * One WebRTC audio call. The caller makes the offer, the agent answers.
 *   const link = new PeerLink({ sendSignal, onRemoteStream, onState });
 *   link.addStream(localStream); if (caller) await link.offer(); link.handleSignal(data); link.close();
 */
export class PeerLink {
  constructor({ sendSignal, onRemoteStream, onState }) {
    this.sendSignal = sendSignal;
    this.pendingIce = [];
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ ice: e.candidate.toJSON() }); };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (onRemoteStream) onRemoteStream(stream);
    };
    this.pc.onconnectionstatechange = () => { if (onState) onState(this.pc.connectionState); };
  }

  addStream(stream) {
    for (const t of stream.getAudioTracks()) this.pc.addTrack(t, stream);
  }

  async offer() {
    const desc = await this.pc.createOffer({ offerToReceiveAudio: true });
    await this.pc.setLocalDescription(desc);
    this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
  }

  async handleSignal(data) {
    if (!data) return;
    if (data.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      if (data.sdp.type === 'offer') {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.sendSignal({ sdp: this.pc.localDescription.toJSON() });
      }
    } else if (data.ice) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.ice).catch(() => {});
      else this.pendingIce.push(data.ice);
    }
  }

  close() {
    try { this.pc.close(); } catch { /* ignore */ }
  }
}

/** Play a remote stream. Chrome also needs this before Web Audio can read a remote WebRTC track. */
export function playStream(stream) {
  const el = new Audio();
  el.autoplay = true;
  el.srcObject = stream;
  el.play().catch(() => { /* autoplay blocked: the answer click usually counts as a gesture */ });
  return el;
}
