;; ============================================================
;; PIXEL: a memory-mapped picture chip
;; ============================================================
;; Same pattern as the REGISTER sound chip: registers in memory, a tiny core
;; that reads them, CAPS to say what it implements. It imports the sound
;; chip's memory, so both chips share one address space like a console:
;;
;;   $1000-$1FFF  sound chip (REGISTER)
;;   $2000-$2FFF  picture chip registers, palette, tables
;;   $3000-$3FFF  64x64 framebuffer, one byte per pixel (palette index 0-3)
;;
;; No floating point: waves come from a 256-byte sine table the chip builds
;; with a parabola at start. Effects are classic demoscene: plasma, rings,
;; raster bars and xor patterns.
;;
;; Visual music (PVOICE): each voice of the song has a visual meaning, so the
;; music can be seen as well as heard. Kick = brightness, snare = warmth,
;; lead = pattern frequency, bass = zoom, noise = sparkle.
;;
;; SAFE (VID_CTRL bit 1): at most 3 flashes a second and softer flashes, per
;; WCAG 2.3.1. The chip enforces it, so every page that uses it is covered.
;; ============================================================

(module
  (import "env" "memory" (memory 1))

  ;; Registers (see pixel-map.json)
  (global $VID_CTRL    i32 (i32.const 0x2000))
  (global $VID_MODE    i32 (i32.const 0x2001))
  (global $VID_SPEED   i32 (i32.const 0x2002))
  (global $VID_FREQ_X  i32 (i32.const 0x2003))
  (global $VID_FREQ_Y  i32 (i32.const 0x2004))
  (global $VID_ZOOM    i32 (i32.const 0x2005))
  (global $VID_WARP    i32 (i32.const 0x2006))
  (global $VID_CYCLE   i32 (i32.const 0x2007))
  (global $SYNC_CTRL   i32 (i32.const 0x2010))
  (global $SYNC_PULSE  i32 (i32.const 0x2011))
  (global $SYNC_STEPS  i32 (i32.const 0x2020))
  (global $VID_FRAME   i32 (i32.const 0x2030))
  (global $VOICE_CTRL  i32 (i32.const 0x2040))
  (global $VOICE_DECAY i32 (i32.const 0x2041))
  (global $VOICE_AMT   i32 (i32.const 0x2042))   ;; 5 bytes: kick snare lead bass noise
  (global $VOICE_LEVEL i32 (i32.const 0x2048))   ;; 5 bytes, written by the chip
  (global $HDMA_CTRL   i32 (i32.const 0x2050))
  (global $HDMA_AMP    i32 (i32.const 0x2051))
  (global $HDMA_FREQ   i32 (i32.const 0x2052))
  (global $HDMA_SPEED  i32 (i32.const 0x2053))
  (global $HDMA_TABLE  i32 (i32.const 0x2080))   ;; 64 signed bytes, one per row
  (global $VID_CAPS    i32 (i32.const 0x20F0))
  (global $VID_SPEC    i32 (i32.const 0x20F4))
  (global $PALETTE     i32 (i32.const 0x2100))
  (global $OUT_PALETTE i32 (i32.const 0x2110))
  (global $SINE        i32 (i32.const 0x2200))
  (global $FB          i32 (i32.const 0x3000))

  ;; The sound chip's registers this chip listens to
  (global $SEQ_STEP    i32 (i32.const 0x1502))
  (global $KICK_GATE   i32 (i32.const 0x1000))
  (global $SNARE_GATE  i32 (i32.const 0x1020))
  (global $LEAD_GATE   i32 (i32.const 0x1100))
  (global $BASS_GATE   i32 (i32.const 0x1200))
  (global $NOISE_GATE  i32 (i32.const 0x1300))

  (global $frame (mut i32) (i32.const 0))
  (global $flash (mut i32) (i32.const 0))
  (global $last_step (mut i32) (i32.const -1))
  (global $last_flash (mut i32) (i32.const -1000))  ;; frame of the last flash
  (global $lead_note (mut i32) (i32.const 0))
  (global $lfsr (mut i32) (i32.const 0xACE1))
  (global $flashed (mut i32) (i32.const 0))  ;; something flashed on this step

  ;; ============ INIT ============
  (func $init (export "init")
    (local $i i32)
    (local $q i32)
    (local $y i32)

    ;; Sine table: a parabola per half wave, centered on 128.
    ;; q * (128 - q) peaks at 4096 when q = 64; >> 5 scales it to 0-128.
    (local.set $i (i32.const 0))
    (block $done
      (loop $fill
        (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
        (local.set $q (i32.and (local.get $i) (i32.const 127)))
        (local.set $y (i32.shr_u
          (i32.mul (local.get $q) (i32.sub (i32.const 128) (local.get $q)))
          (i32.const 5)))
        (if (i32.gt_u (local.get $y) (i32.const 127)) (then (local.set $y (i32.const 127))))
        (i32.store8 (i32.add (global.get $SINE) (local.get $i))
          (if (result i32) (i32.lt_u (local.get $i) (i32.const 128))
            (then (i32.add (i32.const 128) (local.get $y)))
            (else (i32.sub (i32.const 128) (local.get $y)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $fill)
      )
    )

    ;; CAPS: PIXEL, PSYNC, PVOICE, PHDMA (bits 0-3)
    (i32.store (global.get $VID_CAPS) (i32.const 15))
    (i32.store8 (global.get $VID_SPEC) (i32.const 1))
    (global.set $frame (i32.const 0))
  )

  (func $sin (param $x i32) (result i32)
    (i32.load8_u (i32.add (global.get $SINE) (i32.and (local.get $x) (i32.const 255))))
  )

  (func $reg (param $addr i32) (result i32)
    (i32.load8_u (local.get $addr))
  )

  (func $min (param $a i32) (param $b i32) (result i32)
    (select (local.get $a) (local.get $b) (i32.lt_s (local.get $a) (local.get $b)))
  )

  (func $clamp255 (param $v i32) (result i32)
    (if (i32.lt_s (local.get $v) (i32.const 0)) (then (return (i32.const 0))))
    (call $min (local.get $v) (i32.const 255))
  )

  (func $safe (result i32)
    (i32.ne (i32.and (call $reg (global.get $VID_CTRL)) (i32.const 2)) (i32.const 0))
  )

  ;; A flash may start now? In SAFE mode, only if 20 frames (1/3 s at 60 fps)
  ;; have passed since the last one: never more than 3 flashes a second.
  (func $may_flash (result i32)
    (if (call $safe)
      (then
        (return (i32.ge_s (i32.sub (global.get $frame) (global.get $last_flash)) (i32.const 20)))))
    (i32.const 1)
  )

  (func $gate (param $base i32) (param $step i32) (result i32)
    (call $reg (i32.add (local.get $base) (local.get $step)))
  )

  ;; Start a voice's level at full. Kick and snare change brightness and
  ;; color, so they count as flashes: they only start when this step may flash.
  (func $trigger (param $v i32) (param $ok i32)
    (if (i32.le_u (local.get $v) (i32.const 1))
      (then
        (if (i32.eqz (local.get $ok)) (then (return)))
        (global.set $flashed (i32.const 1))))
    (i32.store8 (i32.add (global.get $VOICE_LEVEL) (local.get $v)) (i32.const 255))
  )

  ;; ============ BEAT ============
  ;; When the sound chip moves to a new step: flash for SYNC, and start each
  ;; voice's level if it plays on that step. Levels and flash fade every frame.
  (func $beat
    (local $step i32)
    (local $ctrl i32)
    (local $hit i32)
    (local $v i32)
    (local $level i32)
    (local $decay i32)
    (local $ok i32)

    (local.set $ctrl (call $reg (global.get $SYNC_CTRL)))
    (local.set $step (i32.and (call $reg (global.get $SEQ_STEP)) (i32.const 15)))
    (if (i32.ne (local.get $step) (global.get $last_step))
      (then
        (global.set $last_step (local.get $step))
        ;; One decision per step: everything on this step may flash together,
        ;; and it counts as one flash.
        (local.set $ok (call $may_flash))
        (global.set $flashed (i32.const 0))
        ;; Compare each flag to zero before combining: (ctrl & 2) is 2, not 1,
        ;; and 2 AND 1 is 0. A classic bitwise bug.
        (if (i32.and (i32.ne (i32.and (local.get $ctrl) (i32.const 1)) (i32.const 0))
                     (i32.ne (call $gate (global.get $SYNC_STEPS) (local.get $step)) (i32.const 0)))
          (then (local.set $hit (i32.const 1))))
        (if (i32.and (i32.ne (i32.and (local.get $ctrl) (i32.const 2)) (i32.const 0))
                     (i32.ne (call $gate (global.get $KICK_GATE) (local.get $step)) (i32.const 0)))
          (then (local.set $hit (i32.const 1))))
        (if (i32.and (local.get $hit) (local.get $ok))
          (then
            (global.set $flashed (i32.const 1))
            (global.set $flash
              (if (result i32) (call $safe)
                (then (call $min (call $reg (global.get $SYNC_PULSE)) (i32.const 48)))
                (else (call $reg (global.get $SYNC_PULSE)))))))

        ;; Voices
        (if (call $gate (global.get $KICK_GATE) (local.get $step)) (then (call $trigger (i32.const 0) (local.get $ok))))
        (if (call $gate (global.get $SNARE_GATE) (local.get $step)) (then (call $trigger (i32.const 1) (local.get $ok))))
        (if (call $gate (global.get $LEAD_GATE) (local.get $step))
          (then
            (global.set $lead_note (call $gate (global.get $LEAD_GATE) (local.get $step)))
            (call $trigger (i32.const 2) (local.get $ok))))
        (if (call $gate (global.get $BASS_GATE) (local.get $step)) (then (call $trigger (i32.const 3) (local.get $ok))))
        (if (call $gate (global.get $NOISE_GATE) (local.get $step)) (then (call $trigger (i32.const 4) (local.get $ok))))
        (if (global.get $flashed) (then (global.set $last_flash (global.get $frame))))
      )
    )

    ;; Fades
    (global.set $flash (i32.sub (global.get $flash) (i32.shr_u (i32.add (global.get $flash) (i32.const 7)) (i32.const 3))))
    (local.set $decay (call $reg (global.get $VOICE_DECAY)))
    (if (i32.eqz (local.get $decay)) (then (local.set $decay (i32.const 24))))
    (local.set $v (i32.const 0))
    (block $done
      (loop $voices
        (br_if $done (i32.ge_u (local.get $v) (i32.const 5)))
        (local.set $level (call $reg (i32.add (global.get $VOICE_LEVEL) (local.get $v))))
        (local.set $level (i32.sub (local.get $level)
          (i32.add (i32.shr_u (i32.mul (local.get $level) (local.get $decay)) (i32.const 8)) (i32.const 1))))
        (i32.store8 (i32.add (global.get $VOICE_LEVEL) (local.get $v)) (call $clamp255 (local.get $level)))
        (local.set $v (i32.add (local.get $v) (i32.const 1)))
        (br $voices)
      )
    )
  )

  ;; A voice's effect strength right now: level x amount, 0-255.
  ;; Zero unless that voice's bit is set in VOICE_CTRL.
  (func $drive (param $v i32) (result i32)
    (if (i32.eqz (i32.and (call $reg (global.get $VOICE_CTRL)) (i32.shl (i32.const 1) (local.get $v))))
      (then (return (i32.const 0))))
    (i32.shr_u
      (i32.mul (call $reg (i32.add (global.get $VOICE_LEVEL) (local.get $v)))
               (call $reg (i32.add (global.get $VOICE_AMT) (local.get $v))))
      (i32.const 8))
  )

  ;; ============ PALETTE ============
  ;; OUT_PALETTE = PALETTE, brightened by the kick and warmed by the snare.
  ;; In SAFE mode the kick's brightening is halved.
  (func $palette
    (local $i i32)
    (local $c i32)
    (local $bright i32)
    (local $warm i32)
    (local.set $bright (call $drive (i32.const 0)))
    (if (call $safe) (then (local.set $bright (i32.shr_u (local.get $bright) (i32.const 1)))))
    (local.set $warm (i32.shr_u (call $drive (i32.const 1)) (i32.const 2)))
    (local.set $i (i32.const 0))
    (block $done
      (loop $colors
        (br_if $done (i32.ge_u (local.get $i) (i32.const 12)))
        (local.set $c (call $reg (i32.add (global.get $PALETTE) (local.get $i))))
        ;; Brighten toward white, up to halfway
        (local.set $c (i32.add (local.get $c)
          (i32.shr_u (i32.mul (i32.sub (i32.const 255) (local.get $c)) (local.get $bright)) (i32.const 9))))
        ;; Warmth: more red, less blue (i mod 3: 0 = R, 2 = B)
        (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 3)))
          (then (local.set $c (i32.add (local.get $c) (local.get $warm)))))
        (if (i32.eq (i32.rem_u (local.get $i) (i32.const 3)) (i32.const 2))
          (then (local.set $c (i32.sub (local.get $c) (local.get $warm)))))
        (i32.store8 (i32.add (global.get $OUT_PALETTE) (local.get $i)) (call $clamp255 (local.get $c)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $colors)
      )
    )
  )

  ;; ============ HDMA ============
  ;; Auto wave: fill the per-row table from the sine table, like SNES HDMA
  ;; writing a scroll register on every scanline.
  (func $hdma_fill
    (local $y i32)
    (local $amp i32)
    (local $phase i32)
    (local.set $amp (call $reg (global.get $HDMA_AMP)))
    (local.set $phase (i32.shr_u (i32.mul (global.get $frame) (call $reg (global.get $HDMA_SPEED))) (i32.const 4)))
    (local.set $y (i32.const 0))
    (block $done
      (loop $rows
        (br_if $done (i32.ge_u (local.get $y) (i32.const 64)))
        (i32.store8 (i32.add (global.get $HDMA_TABLE) (local.get $y))
          (i32.shr_s
            (i32.mul (i32.sub (call $sin (i32.add
                       (i32.shr_u (i32.mul (local.get $y) (call $reg (global.get $HDMA_FREQ))) (i32.const 2))
                       (local.get $phase)))
                     (i32.const 128))
                     (local.get $amp))
            (i32.const 7)))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)
      )
    )
  )

  ;; This row's horizontal shift: a signed byte from the table
  (func $row_shift (param $y i32) (result i32)
    (local $ctrl i32)
    (local $s i32)
    (local.set $ctrl (call $reg (global.get $HDMA_CTRL)))
    (if (i32.eqz (i32.and (local.get $ctrl) (i32.const 1))) (then (return (i32.const 0))))
    (local.set $s (i32.load8_s (i32.add (global.get $HDMA_TABLE) (local.get $y))))
    (if (i32.and (i32.ne (i32.and (local.get $ctrl) (i32.const 4)) (i32.const 0))
                 (i32.and (local.get $y) (i32.const 1)))
      (then (local.set $s (i32.sub (i32.const 0) (local.get $s)))))
    (local.get $s)
  )

  ;; 16-bit Galois LFSR: the classic hardware noise source
  (func $noise (result i32)
    (local $l i32)
    (local.set $l (global.get $lfsr))
    (global.set $lfsr (i32.xor
      (i32.shr_u (local.get $l) (i32.const 1))
      (i32.and (i32.sub (i32.const 0) (i32.and (local.get $l) (i32.const 1))) (i32.const 0xB400))))
    (i32.and (global.get $lfsr) (i32.const 255))
  )

  ;; ============ ONE PIXEL ============
  ;; Returns a value 0-255; the top two bits pick the palette color.
  (func $shade (param $x i32) (param $y i32) (param $t i32) (param $mode i32)
               (param $fx i32) (param $fy i32) (param $zoom i32) (param $warp i32) (result i32)
    (local $dx i32)
    (local $dy i32)
    (local $d i32)

    ;; 0: plasma, three waves averaged
    (if (i32.eqz (local.get $mode))
      (then
        (return (i32.div_u
          (i32.add
            (i32.add
              (call $sin (i32.add (i32.shr_u (i32.mul (local.get $x) (local.get $fx)) (i32.const 2))
                                  (i32.add (local.get $t)
                                    (i32.shr_u (i32.mul (call $sin (i32.add (local.get $y) (local.get $t))) (local.get $warp)) (i32.const 8)))))
              (call $sin (i32.add (i32.shr_u (i32.mul (local.get $y) (local.get $fy)) (i32.const 2))
                                  (i32.shl (local.get $t) (i32.const 1)))))
            (call $sin (i32.add (i32.shr_u (i32.mul (i32.add (local.get $x) (local.get $y)) (local.get $zoom)) (i32.const 3))
                                (local.get $t))))
          (i32.const 3)))))

    ;; 1: rings around the center
    (if (i32.eq (local.get $mode) (i32.const 1))
      (then
        (local.set $dx (i32.sub (local.get $x) (i32.const 32)))
        (local.set $dy (i32.sub (local.get $y) (i32.const 32)))
        (local.set $d (i32.shr_u
          (i32.mul (i32.add (i32.mul (local.get $dx) (local.get $dx)) (i32.mul (local.get $dy) (local.get $dy)))
                   (i32.add (local.get $zoom) (i32.const 1)))
          (i32.const 6)))
        (return (call $sin (i32.add (i32.sub (local.get $d) (i32.shl (local.get $t) (i32.const 2)))
          (i32.shr_u (i32.mul (call $sin (i32.add (i32.mul (local.get $x) (local.get $fx)) (local.get $t))) (local.get $warp)) (i32.const 7)))))))

    ;; 2: raster bars, bent by a second wave
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then
        (return (call $sin (i32.add
          (i32.add (i32.shr_u (i32.mul (local.get $y) (i32.add (local.get $fy) (i32.const 1))) (i32.const 1))
                   (i32.shl (local.get $t) (i32.const 1)))
          (i32.shr_u (i32.mul (call $sin (i32.add (i32.shr_u (i32.mul (local.get $x) (local.get $fx)) (i32.const 2)) (local.get $t)))
                              (local.get $warp))
                     (i32.const 6)))))))

    ;; 3: xor texture
    (i32.add
      (i32.shl
        (i32.xor
          (i32.shr_u (i32.mul (local.get $x) (i32.add (local.get $fx) (i32.const 1))) (i32.const 2))
          (i32.shr_u (i32.mul (local.get $y) (i32.add (local.get $fy) (i32.const 1))) (i32.const 2)))
        (i32.const 3))
      (local.get $t))
  )

  ;; ============ RENDER ============
  ;; Draws one frame into the framebuffer. Returns 1 if it drew.
  (func $render (export "render") (result i32)
    (local $x i32)
    (local $y i32)
    (local $t i32)
    (local $mode i32)
    (local $fx i32)
    (local $fy i32)
    (local $zoom i32)
    (local $warp i32)
    (local $offset i32)
    (local $shift i32)
    (local $sparkle i32)
    (local $color i32)

    (if (i32.eqz (i32.and (call $reg (global.get $VID_CTRL)) (i32.const 1)))
      (then (return (i32.const 0))))

    (global.set $frame (i32.add (global.get $frame) (i32.const 1)))
    (i32.store16 (global.get $VID_FRAME) (global.get $frame))
    (call $beat)
    (call $palette)
    (if (i32.eq (i32.and (call $reg (global.get $HDMA_CTRL)) (i32.const 3)) (i32.const 3))
      (then (call $hdma_fill)))

    (local.set $t (i32.shr_u (i32.mul (global.get $frame) (call $reg (global.get $VID_SPEED))) (i32.const 5)))
    (local.set $mode (i32.and (call $reg (global.get $VID_MODE)) (i32.const 3)))
    ;; Lead raises the pattern frequency: higher notes, finer pattern
    (local.set $fx (i32.add (call $reg (global.get $VID_FREQ_X))
      (i32.shr_u (i32.mul (i32.and (global.get $lead_note) (i32.const 63)) (call $drive (i32.const 2))) (i32.const 8))))
    (local.set $fy (call $reg (global.get $VID_FREQ_Y)))
    ;; Bass zooms the pattern
    (local.set $zoom (i32.add (call $reg (global.get $VID_ZOOM)) (i32.shr_u (call $drive (i32.const 3)) (i32.const 3))))
    (local.set $warp (call $reg (global.get $VID_WARP)))
    ;; Palette cycling plus the beat flash both shift which color a value gets
    (local.set $offset (i32.add
      (i32.shr_u (i32.mul (global.get $frame) (call $reg (global.get $VID_CYCLE))) (i32.const 4))
      (global.get $flash)))
    ;; Noise sparkles: chance per pixel, out of 256
    (local.set $sparkle (i32.shr_u (call $drive (i32.const 4)) (i32.const 3)))

    (local.set $y (i32.const 0))
    (block $rows_done
      (loop $rows
        (br_if $rows_done (i32.ge_u (local.get $y) (i32.const 64)))
        (local.set $shift (call $row_shift (local.get $y)))
        (local.set $x (i32.const 0))
        (block $cols_done
          (loop $cols
            (br_if $cols_done (i32.ge_u (local.get $x) (i32.const 64)))
            (local.set $color
              (i32.and (i32.shr_u
                (i32.add
                  (call $shade (i32.and (i32.add (local.get $x) (local.get $shift)) (i32.const 63))
                               (local.get $y) (local.get $t) (local.get $mode)
                               (local.get $fx) (local.get $fy) (local.get $zoom) (local.get $warp))
                  (local.get $offset))
                (i32.const 6)) (i32.const 3)))
            (if (i32.and (i32.ne (local.get $sparkle) (i32.const 0))
                         (i32.lt_u (call $noise) (local.get $sparkle)))
              (then (local.set $color (i32.const 3))))
            (i32.store8
              (i32.add (global.get $FB) (i32.add (i32.shl (local.get $y) (i32.const 6)) (local.get $x)))
              (local.get $color))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $cols)
          )
        )
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)
      )
    )
    (i32.const 1)
  )
)
