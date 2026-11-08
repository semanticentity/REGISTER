/*
 * WHITE DWARF adapter: attaches REGISTER to WHITE DWARF.
 *
 * Controls (sliders, selects) are bridged by dom-bridge.js on their own.
 * This file adds the state WHITE DWARF keeps in objects instead of controls:
 *
 *   stepmeta  per-step velocity, probability, ratchet, trig pass, bass accent
 *   lyra      Lyra note banks A-D: note, flags (active, slide, accent), gate
 *   patch     the patch bay: source, destination and amount for 16 slots
 *
 * Load after white-dwarf-map.js, map-panel.js, register-console.js and
 * dom-bridge.js. It waits for WHITE DWARF to start, then attaches.
 */
(function (global) {
  'use strict';
  const unit = { read: v => (v === undefined || v >= 1 ? 0 : Math.max(1, Math.round(v * 255))), write: b => (b ? b / 255 : 1) };
  const PASS = ['always', 'first', 'second'];

  function adapter(audio) {
    const redraw = () => { try { audio.updatePatternEditor(); } catch (e) { /* the grid redraws on its next tick */ } };

    const stepmeta = {
      read(b, mem) {
        const c = b.c, meta = (audio.stepMeta && audio.stepMeta[c.track]) || {};
        for (let i = 0; i < 16; i++) {
          const m = meta[c.offset + i] || {};
          let v = 0;
          if (c.codec === 'unit') v = unit.read(m[c.key]);
          else if (c.codec === 'raw') v = m[c.key] > 1 ? m[c.key] : 0;
          else if (c.codec === 'pass') v = Math.max(0, PASS.indexOf(m.triggerPass || 'always'));
          else if (c.codec === 'flag') v = m[c.key] === true ? 1 : 0;
          mem[b.addr + i] = v;
        }
      },
      write(b, mem) {
        const c = b.c;
        audio.stepMeta[c.track] = audio.stepMeta[c.track] || {};
        const meta = audio.stepMeta[c.track];
        for (let i = 0; i < 16; i++) {
          const k = c.offset + i, byte = mem[b.addr + i];
          const m = meta[k] || { velocity: 1, prob: 1, ratchet: 1 };
          if (c.codec === 'unit') m[c.key] = unit.write(byte);
          else if (c.codec === 'raw') m[c.key] = byte ? Math.max(1, Math.min(8, byte)) : 1;
          else if (c.codec === 'pass') m.triggerPass = PASS[byte] || 'always';
          else if (c.codec === 'flag') m[c.key] = !!byte;
          const plain = (m.velocity ?? 1) === 1 && (m.prob ?? 1) === 1 && (m.ratchet ?? 1) === 1 &&
            (m.triggerPass || 'always') === 'always' && !m.accent;
          if (plain) delete meta[k]; else meta[k] = m;
        }
        redraw();
      }
    };

    const lyra = {
      read(b, mem) {
        const steps = (audio.lyraBanks && audio.lyraBanks[b.c.bank]) || [];
        for (let i = 0; i < 16; i++) {
          const s = steps[i] || {};
          let v = 0;
          if (b.c.key === 'note') v = Math.max(0, Math.min(24, s.note | 0));
          else if (b.c.key === 'flags') v = (s.active ? 1 : 0) | (s.slide ? 2 : 0) | (s.accent ? 4 : 0);
          else if (b.c.key === 'gate') v = unit.read(s.gate);
          mem[b.addr + i] = v;
        }
      },
      write(b, mem) {
        const steps = audio.lyraBanks && audio.lyraBanks[b.c.bank];
        if (!steps) return false;
        for (let i = 0; i < 16; i++) {
          const s = steps[i] || (steps[i] = { active: false, note: 0, slide: false, accent: false, gate: 1 });
          const byte = mem[b.addr + i];
          if (b.c.key === 'note') s.note = Math.min(24, byte);
          else if (b.c.key === 'flags') { s.active = !!(byte & 1); s.slide = !!(byte & 2); s.accent = !!(byte & 4); }
          else if (b.c.key === 'gate') s.gate = Math.max(0.1, unit.write(byte));
        }
        try { audio.updateLyraSequencerUI(); } catch (e) { /* redraws on its next tick */ }
        return true;
      }
    };

    // The patch bay is a list. Slot n is the nth patch; "none" in a slot's
    // source or destination removes that patch, and the list closes up.
    // -1..1 as a byte: 0 = -1, 128 = 0, 255 = +1
    const signed = { read: v => Math.max(0, Math.min(255, Math.round((v || 0) * 127 + 128))), write: b => Math.max(-1, Math.min(1, (b - 128) / 127)) };
    const patch = {
      read(b, mem) {
        const p = audio.patches[b.c.slot], f = b.f, part = b.c.part;
        if (part === 'amount') { mem[b.addr] = p ? Math.max(0, Math.min(255, Math.round(p.amount * 64 + 128))) : 128; return; }
        if (part === 'lock') { mem[b.addr] = p && p.isLocked ? 1 : 0; return; }
        if (part === 'held') { mem[b.addr] = signed.read(p ? p.lockedValue : 0); return; }
        if (part === 'min') { mem[b.addr] = signed.read(p ? p.modRangeMin ?? -1 : -1); return; }
        if (part === 'max') { mem[b.addr] = signed.read(p ? p.modRangeMax ?? 1 : 1); return; }
        const i = p ? f.options.indexOf(p[b.c.part]) : 0;
        mem[b.addr] = i < 0 ? 0 : i;
      },
      write(b, mem) {
        // Rebuild the whole list from the 16 slots, so the result does not
        // depend on the order slots are written in.
        const map = global.WHITE_DWARF_MAP;
        const field = n => map.regions.find(r => r.name === n);
        const at = n => parseInt(field(n).start, 16);
        const srcOpts = field('PATCH_1_SOURCE').fields[0].options, dstOpts = field('PATCH_1_DEST').fields[0].options;
        // A slot given one end gets the first option at the other, so it plays at once
        const s0 = at(`PATCH_${b.c.slot + 1}_SOURCE`), d0 = at(`PATCH_${b.c.slot + 1}_DEST`);
        if (b.c.part === 'source' && mem[s0] && !mem[d0]) mem[d0] = 1;
        if (b.c.part === 'dest' && mem[d0] && !mem[s0]) mem[s0] = 1;
        const old = audio.patches;
        const next = [];
        for (let i = 0; i < 16; i++) {
          const n = `PATCH_${i + 1}_`;
          const source = srcOpts[mem[at(n + 'SOURCE')]], dest = dstOpts[mem[at(n + 'DEST')]];
          if (!source || !dest || source === 'none' || dest === 'none') continue;
          const prev = old[next.length] || {};
          next.push({
            ...prev,
            id: prev.id || crypto.randomUUID(),
            source, dest,
            amount: Math.round(((mem[at(n + 'AMOUNT')] - 128) / 64) * 100) / 100,
            isLocked: !!(mem[at(n + 'LOCK')] & 1),
            lockedValue: signed.write(mem[at(n + 'HELD')]),
            modRangeMin: signed.write(mem[at(n + 'MIN')]),
            modRangeMax: signed.write(mem[at(n + 'MAX')])
          });
        }
        // WHITE DWARF resets the Lyra gate when its patch goes away; keep that
        if (old.some(p => p.dest === 'LYRA GATE PROB') && !next.some(p => p.dest === 'LYRA GATE PROB')) {
          audio.lyraGlobalGateProbability = 1.0;
          try { audio.stopAllLyraNotes(); } catch (e) { /* nothing playing */ }
        }
        audio.patches = next;
        try { audio.renderPatchesUI(); } catch (e) { /* redraws on its next change */ }
        return true;
      }
    };

    // Lyra: which bank the editor shows, and the chain the banks play in
    const lyrabank = {
      read(b, mem) {
        if (b.c.part === 'edit') { mem[b.addr] = Math.max(0, 'ABCD'.indexOf(audio.lyraEditBank || 'A')); return; }
        const chain = String(audio.lyraBankChain || 'A');
        for (let i = 0; i < 16; i++) { const ch = chain[b.c.offset + i]; mem[b.addr + i] = ch ? 'ABCD'.indexOf(ch) + 1 : 0; }
      },
      write(b, mem) {
        if (b.c.part === 'edit') { audio.selectLyraEditBank('ABCD'[mem[b.addr]] || 'A'); return true; }
        // The chain is read from both halves; it ends at the first 0
        const region = n => parseInt(global.WHITE_DWARF_MAP.regions.find(r => r.name === n).start, 16);
        const bytes = [...mem.subarray(region('LYRA_CHAIN_1_16'), region('LYRA_CHAIN_1_16') + 16), ...mem.subarray(region('LYRA_CHAIN_17_32'), region('LYRA_CHAIN_17_32') + 16)];
        let chain = '';
        for (const v of bytes) { if (!v || v > 4) break; chain += 'ABCD'[v - 1]; }
        const set = audio.setLyraBankChain(chain || 'A');
        const input = document.getElementById('lyraBankChain');
        if (input) input.value = set;
        return true;
      }
    };

    // Effects rack: order, which effects are on, and each one's mix.
    // Written back through WHITE DWARF's own applyFxRackState.
    const fxrack = {
      read(b, mem) {
        if (!audio.fxRack) return;
        const names = audio.fxRackOrder || [];
        if (b.c.part === 'order') { mem[b.addr] = Math.max(0, b.f.options.indexOf(names[b.c.slot])); return; }
        if (b.c.part === 'on') {
          let v = 0;
          b.f.bits.forEach((n, i) => { const e = Object.entries(audio.fxRack).find(([k]) => k.toLowerCase() === n); if (e && e[1].enabled) v |= 1 << i; });
          mem[b.addr] = v;
          return;
        }
        const f = audio.fxRack[b.c.effect];
        mem[b.addr] = f ? Math.round((f.mix ?? 0) * 255) : 0;
      },
      write(b, mem) {
        if (!audio.fxRack) return false;
        const map = global.WHITE_DWARF_MAP;
        const at = n => parseInt(map.regions.find(r => r.name === n).start, 16);
        const names = map.regions.find(r => r.name === 'FX_SLOT_1').fields[0].options;
        const order = [];
        for (let i = 0; i < 6; i++) { const n = names[mem[at(`FX_SLOT_${i + 1}`)]]; if (n && !order.includes(n)) order.push(n); }
        const on = mem[at('FX_ON')];
        const effects = {};
        names.forEach((n, i) => { effects[n] = { enabled: !!(on & (1 << i)), mix: mem[at(`FX_${n.toUpperCase()}_MIX`)] / 255 }; });
        audio.applyFxRackState({ order, effects });
        return true;
      }
    };

    return { stepmeta, lyra, patch, lyrabank, fxrack };
  }

  function start() {
    const audio = global.app && global.app.audioSystem;
    if (!audio || !global.RegisterBridge || !global.WHITE_DWARF_MAP) return setTimeout(start, 200);
    const bridge = RegisterBridge.attach({
      map: global.WHITE_DWARF_MAP,
      afterArrayWrite: () => { try { audio.updatePatternEditor(); } catch (e) { /* next tick */ } },
      custom: adapter(audio)
    });
    RegisterBridge.dock({ map: global.WHITE_DWARF_MAP, bridge });
    global.WD_REGISTER = bridge;
  }
  start();
})(typeof window !== 'undefined' ? window : globalThis);
