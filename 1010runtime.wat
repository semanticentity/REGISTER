;; $1010 APU Runtime
;; WebAssembly Text Format (.wat)
;;
;; This is the sequencer core - runs the 16-step loop,
;; reads from audio memory, emits gate events.
;;
;; Audio synthesis happens in the host (JS AudioWorklet).
;; This module handles: memory, timing, state.

(module
  ;; ============ MEMORY ============
  ;; 64KB address space (matches MTMC-16)
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

  ;; ============ STATE ============
  (global $current_step (mut i32) (i32.const 0))
  (global $is_playing (mut i32) (i32.const 0))

  ;; ============ IMPORTS ============
  ;; Host provides audio callbacks
  (import "audio" "triggerKick" (func $triggerKick (param i32)))      ;; pitch
  (import "audio" "triggerSnare" (func $triggerSnare (param i32) (param i32))) ;; tone, snap
  (import "audio" "triggerLead" (func $triggerLead (param i32)))      ;; note
  (import "audio" "triggerBass" (func $triggerBass (param i32) (param i32)))   ;; note, fm
  (import "audio" "triggerNoise" (func $triggerNoise (param i32)))    ;; decay

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

  ;; ============ TICK (main sequencer step) ============
  ;; Called by host at tempo rate
  ;; Returns 1 if we're playing, 0 if stopped

  (func $tick (export "tick") (result i32)
    (local $step i32)
    (local $gate i32)
    (local $param1 i32)
    (local $param2 i32)

    ;; Check if playing
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
