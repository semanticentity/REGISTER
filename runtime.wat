;; REGISTER APU Runtime
;; WebAssembly Text Format (.wat)
;;
;; This is the sequencer core - runs the 16-step loop,
;; reads from audio memory, emits gate events.
;;
;; Audio synthesis happens in the host (JS AudioWorklet).
;; This module handles: memory, timing, state.

(module
  ;; ============ IMPORTS ============
  ;; Host provides audio callbacks
  (import "audio" "triggerKick" (func $triggerKick (param i32)))      ;; pitch
  (import "audio" "triggerSnare" (func $triggerSnare (param i32) (param i32))) ;; tone, snap
  (import "audio" "triggerLead" (func $triggerLead (param i32)))      ;; note
  (import "audio" "triggerBass" (func $triggerBass (param i32) (param i32)))   ;; note, fm
  (import "audio" "triggerNoise" (func $triggerNoise (param i32)))    ;; decay

  ;; ============ MEMORY ============
  ;; 64KB address space; the chip uses $1000-$1FFF
  ;; Audio region: $1000-$15FF
  (memory (export "memory") 1)

  ;; ============ CONSTANTS ============
  ;; Voice base addresses
  (global $KICK_GATE i32 (i32.const 0x1000))
  (global $KICK_PITCH i32 (i32.const 0x1010))
  (global $SNARE_GATE i32 (i32.const 0x1020))
  (global $SNARE_TONE i32 (i32.const 0x1030))
  (global $SNARE_SNAP i32 (i32.const 0x1040))
  (global $LEAD_GATE i32 (i32.const 0x1100))
  (global $LEAD_ARP i32 (i32.const 0x1110))
  (global $BASS_GATE i32 (i32.const 0x1200))
  (global $BASS_FM i32 (i32.const 0x1210))
  (global $BASS_FILT i32 (i32.const 0x1220))
  (global $NOISE_GATE i32 (i32.const 0x1300))
  (global $NOISE_DECAY i32 (i32.const 0x1310))
  (global $NOISE_TYPE i32 (i32.const 0x1320))

  ;; Sequencer registers
  (global $SEQ_CTRL i32 (i32.const 0x1500))
  (global $SEQ_TEMPO i32 (i32.const 0x1501))
  (global $SEQ_STEP i32 (i32.const 0x1502))
  (global $SEQ_SWING i32 (i32.const 0x1503))
  (global $CAPS i32 (i32.const 0x15F0))          ;; 4 bytes, read-only: packs this machine implements
  (global $SPEC_VERSION i32 (i32.const 0x15F4))  ;; read-only: memory map version

  ;; XSONG arranger: a tiny program of timed events
  (global $SONG_POS i32 (i32.const 0x1760))      ;; 16-bit song position, in steps
  (global $SONG_CTRL i32 (i32.const 0x1762))     ;; bit 0 = arranger on
  (global $SONG_COUNT i32 (i32.const 0x1763))    ;; events in the table
  (global $SONG_EVENTS i32 (i32.const 0x1770))   ;; 24 events x 6 bytes
  (global $SONG_BANK i32 (i32.const 0x1800))     ;; 16 stored patterns x 16 bytes

  ;; ============ STATE ============
  (global $current_step (mut i32) (i32.const 0))
  (global $is_playing (mut i32) (i32.const 0))


  ;; ============ MEMORY ACCESS ============

  ;; Read byte from address
  (func $read (export "read") (param $addr i32) (result i32)
    (i32.load8_u (local.get $addr))
  )

  ;; Write byte to address
  (func $write (export "write") (param $addr i32) (param $val i32)
    (i32.store8 (local.get $addr) (local.get $val))
  )

  ;; ============ INITIALIZATION ============

  (func $init (export "init")
    ;; Reset step
    (global.set $current_step (i32.const 0))
    (global.set $is_playing (i32.const 0))

    ;; Default tempo: 120 BPM
    (i32.store8 (global.get $SEQ_TEMPO) (i32.const 120))

    ;; Default swing: 0
    (i32.store8 (global.get $SEQ_SWING) (i32.const 0))

    ;; Stopped
    (i32.store8 (global.get $SEQ_CTRL) (i32.const 0))

    ;; Declare capabilities: CORE and the XSONG arranger
    (i32.store (global.get $CAPS) (i32.const 0x20000001))  ;; CORE (bit 0) + XSONG (bit 29)
    (i32.store8 (global.get $SPEC_VERSION) (i32.const 1))
  )

  ;; ============ SEQUENCER CONTROL ============

  (func $start (export "start")
    (global.set $is_playing (i32.const 1))
    (i32.store8 (global.get $SEQ_CTRL) (i32.const 3))  ;; play + loop
  )

  (func $stop (export "stop")
    (global.set $is_playing (i32.const 0))
    (i32.store8 (global.get $SEQ_CTRL) (i32.const 0))
  )

  (func $reset (export "reset")
    (global.set $current_step (i32.const 0))
    (i32.store8 (global.get $SEQ_STEP) (i32.const 0))
    (i32.store16 (global.get $SONG_POS) (i32.const 0))
  )

  (func $getStep (export "getStep") (result i32)
    (global.get $current_step)
  )

  (func $getTempo (export "getTempo") (result i32)
    (i32.load8_u (global.get $SEQ_TEMPO))
  )

  (func $setTempo (export "setTempo") (param $bpm i32)
    (i32.store8 (global.get $SEQ_TEMPO) (local.get $bpm))
  )

  (func $isPlaying (export "isPlaying") (result i32)
    (global.get $is_playing)
  )

  ;; ============ ARRANGER (XSONG) ============
  ;; Runs the events whose step equals the song position, then advances it.
  ;; Event: step lo, step hi, op, a, b, c
  ;;   op 1 POKE  write c to address (a | b<<8)
  ;;   op 2 COPY  copy bank slot a (16 bytes) into voice b's gates
  ;;   op 3 JUMP  set the song position to (a | b<<8), then run that step
  ;;   op 4 STOP  clear SEQ_CTRL
  ;; A loop is a JUMP: the same move as a CPU writing its program counter.

  (func $voice_base (param $v i32) (result i32)
    (if (i32.eq (local.get $v) (i32.const 1)) (then (return (global.get $SNARE_GATE))))
    (if (i32.eq (local.get $v) (i32.const 2)) (then (return (global.get $LEAD_GATE))))
    (if (i32.eq (local.get $v) (i32.const 3)) (then (return (global.get $BASS_GATE))))
    (if (i32.eq (local.get $v) (i32.const 4)) (then (return (global.get $NOISE_GATE))))
    (global.get $KICK_GATE)
  )

  (func $arrange
    (local $pos i32)
    (local $count i32)
    (local $i i32)
    (local $e i32)
    (local $op i32)
    (local $jumped i32)
    (local $src i32)
    (local $dst i32)
    (local $k i32)

    (if (i32.eqz (i32.and (i32.load8_u (global.get $SONG_CTRL)) (i32.const 1)))
      (then (return))
    )
    (local.set $pos (i32.load16_u (global.get $SONG_POS)))
    (local.set $count (i32.load8_u (global.get $SONG_COUNT)))
    (if (i32.gt_u (local.get $count) (i32.const 24))
      (then (local.set $count (i32.const 24)))
    )

    (loop $again
      (local.set $i (i32.const 0))
      (block $events_done
        (loop $events
          (br_if $events_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $e (i32.add (global.get $SONG_EVENTS) (i32.mul (local.get $i) (i32.const 6))))

          (if (i32.eq (i32.load16_u (local.get $e)) (local.get $pos))
            (then
              (local.set $op (i32.load8_u (i32.add (local.get $e) (i32.const 2))))

              ;; POKE
              (if (i32.eq (local.get $op) (i32.const 1))
                (then
                  (i32.store8
                    (i32.load16_u (i32.add (local.get $e) (i32.const 3)))
                    (i32.load8_u (i32.add (local.get $e) (i32.const 5))))
                )
              )

              ;; COPY
              (if (i32.eq (local.get $op) (i32.const 2))
                (then
                  (local.set $src (i32.add (global.get $SONG_BANK)
                    (i32.mul (i32.and (i32.load8_u (i32.add (local.get $e) (i32.const 3))) (i32.const 15)) (i32.const 16))))
                  (local.set $dst (call $voice_base (i32.load8_u (i32.add (local.get $e) (i32.const 4)))))
                  (local.set $k (i32.const 0))
                  (block $copied
                    (loop $copy
                      (br_if $copied (i32.ge_u (local.get $k) (i32.const 16)))
                      (i32.store8 (i32.add (local.get $dst) (local.get $k))
                        (i32.load8_u (i32.add (local.get $src) (local.get $k))))
                      (local.set $k (i32.add (local.get $k) (i32.const 1)))
                      (br $copy)
                    )
                  )
                )
              )

              ;; JUMP (once per step, so a bad table can't hang the chip)
              (if (i32.and (i32.eq (local.get $op) (i32.const 3)) (i32.eqz (local.get $jumped)))
                (then
                  (local.set $pos (i32.load16_u (i32.add (local.get $e) (i32.const 3))))
                  (local.set $jumped (i32.const 1))
                  ;; Keep the bar step in line with the song, like a tracker row
                  (global.set $current_step (i32.and (local.get $pos) (i32.const 15)))
                  (br $again)
                )
              )

              ;; STOP
              (if (i32.eq (local.get $op) (i32.const 4))
                (then
                  (i32.store8 (global.get $SEQ_CTRL) (i32.const 0))
                  (global.set $is_playing (i32.const 0))
                )
              )
            )
          )

          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $events)
        )
      )
    )

    (i32.store16 (global.get $SONG_POS) (i32.add (local.get $pos) (i32.const 1)))
  )

  ;; ============ TICK (main sequencer step) ============
  ;; Called by host at tempo rate
  ;; Returns 1 if we're playing, 0 if stopped

  (func $tick (export "tick") (result i32)
    (local $step i32)
    (local $gate i32)
    (local $param1 i32)
    (local $param2 i32)

    ;; Check if playing. SEQ_CTRL in memory is the truth, so a STOP event
    ;; or a host POKE to $1500 stops the chip.
    (if (i32.eqz (global.get $is_playing))
      (then (return (i32.const 0)))
    )
    (if (i32.eqz (i32.and (i32.load8_u (global.get $SEQ_CTRL)) (i32.const 1)))
      (then
        (global.set $is_playing (i32.const 0))
        (return (i32.const 0))
      )
    )

    ;; Song structure first, so a pattern change lands on its own step
    (call $arrange)
    (if (i32.eqz (global.get $is_playing))
      (then (return (i32.const 0)))
    )

    ;; Get current step
    (local.set $step (global.get $current_step))

    ;; Update step register
    (i32.store8 (global.get $SEQ_STEP) (local.get $step))

    ;; === KICK ===
    (local.set $gate (i32.load8_u (i32.add (global.get $KICK_GATE) (local.get $step))))
    (if (local.get $gate)
      (then
        (local.set $param1 (i32.load8_u (i32.add (global.get $KICK_PITCH) (local.get $step))))
        (if (i32.eqz (local.get $param1))
          (then (local.set $param1 (i32.const 36)))  ;; default pitch
        )
        (call $triggerKick (local.get $param1))
      )
    )

    ;; === SNARE ===
    (local.set $gate (i32.load8_u (i32.add (global.get $SNARE_GATE) (local.get $step))))
    (if (local.get $gate)
      (then
        (local.set $param1 (i32.load8_u (i32.add (global.get $SNARE_TONE) (local.get $step))))
        (if (i32.eqz (local.get $param1))
          (then (local.set $param1 (i32.const 180)))
        )
        (local.set $param2 (i32.load8_u (i32.add (global.get $SNARE_SNAP) (local.get $step))))
        (if (i32.eqz (local.get $param2))
          (then (local.set $param2 (i32.const 100)))
        )
        (call $triggerSnare (local.get $param1) (local.get $param2))
      )
    )

    ;; === LEAD ===
    (local.set $gate (i32.load8_u (i32.add (global.get $LEAD_GATE) (local.get $step))))
    (if (local.get $gate)
      (then
        (call $triggerLead (local.get $gate))  ;; gate IS the note
      )
    )

    ;; === BASS ===
    (local.set $gate (i32.load8_u (i32.add (global.get $BASS_GATE) (local.get $step))))
    (if (local.get $gate)
      (then
        (local.set $param1 (i32.load8_u (i32.add (global.get $BASS_FM) (local.get $step))))
        (if (i32.eqz (local.get $param1))
          (then (local.set $param1 (i32.const 40)))
        )
        (call $triggerBass (local.get $gate) (local.get $param1))
      )
    )

    ;; === NOISE ===
    (local.set $gate (i32.load8_u (i32.add (global.get $NOISE_GATE) (local.get $step))))
    (if (local.get $gate)
      (then
        (local.set $param1 (i32.load8_u (i32.add (global.get $NOISE_DECAY) (local.get $step))))
        (if (i32.eqz (local.get $param1))
          (then (local.set $param1 (i32.const 8)))
        )
        (call $triggerNoise (local.get $param1))
      )
    )

    ;; Advance step (wrap at 16)
    (global.set $current_step
      (i32.and
        (i32.add (local.get $step) (i32.const 1))
        (i32.const 15)
      )
    )

    ;; Return playing status
    (i32.const 1)
  )

  ;; ============ BULK LOAD ============
  ;; Load pattern data from host

  (func $loadPattern (export "loadPattern")
    (param $voice i32)    ;; 0=kick, 1=snare, 2=lead, 3=bass, 4=noise
    (param $dataPtr i32)  ;; pointer to 16 bytes in host memory
    (local $baseAddr i32)
    (local $i i32)

    ;; Determine base address
    (if (i32.eq (local.get $voice) (i32.const 0))
      (then (local.set $baseAddr (global.get $KICK_GATE)))
    )
    (if (i32.eq (local.get $voice) (i32.const 1))
      (then (local.set $baseAddr (global.get $SNARE_GATE)))
    )
    (if (i32.eq (local.get $voice) (i32.const 2))
      (then (local.set $baseAddr (global.get $LEAD_GATE)))
    )
    (if (i32.eq (local.get $voice) (i32.const 3))
      (then (local.set $baseAddr (global.get $BASS_GATE)))
    )
    (if (i32.eq (local.get $voice) (i32.const 4))
      (then (local.set $baseAddr (global.get $NOISE_GATE)))
    )

    ;; Copy 16 bytes
    (local.set $i (i32.const 0))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $i) (i32.const 16)))
        (i32.store8
          (i32.add (local.get $baseAddr) (local.get $i))
          (i32.load8_u (i32.add (local.get $dataPtr) (local.get $i)))
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $copy)
      )
    )
  )
)
