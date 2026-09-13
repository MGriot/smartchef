import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';

/**
 * A textarea that grows with what is typed into it.
 *
 * The one-line CSS answer, `field-sizing: content`, is what these boxes
 * already asked for — and it is inert in the app people actually use them
 * in: the Electron build is Chromium 114 and that property landed in 123. So
 * every "auto-sizing" box in the recipe editor was in fact a fixed 110–150px
 * box with a scrollbar, which is exactly how it was reported. Android's
 * WebView is whatever version the device shipped, so it cannot be relied on
 * there either.
 *
 * Measuring in JS works everywhere. The height cap stays in CSS
 * (`max-h-[50vh]` and friends): the element is only ever *told* to be as
 * tall as its content, and the stylesheet clamps that, so a very long
 * description still scrolls inside its own box rather than pushing the save
 * button off the screen.
 *
 * Forwards its ref, because callers that insert text at the cursor
 * (StepEditor's reference toolbar) need the real element.
 */
const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }
>(function AutoTextarea({ value, onChange, className = '', ...rest }, forwardedRef) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => ref.current as HTMLTextAreaElement, []);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Collapse first, or scrollHeight can only ever report "at least as tall
    // as it already is": the box would grow monotonically and never shrink
    // back when text is deleted.
    el.style.height = 'auto';
    // Borders sit outside scrollHeight but inside the border-box height
    // Tailwind sets, so they have to be added back or the box lands a pixel
    // or two short and shows a scrollbar it does not need.
    const style = window.getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${el.scrollHeight + (Number.isFinite(borders) ? borders : 0)}px`;
  }, []);

  // Layout effect, not a plain one: this runs before paint, so a recipe
  // opening in the editor is never shown at the wrong height first.
  useLayoutEffect(resize, [resize, value]);

  // The cap is in viewport units, so a resized window changes what "too
  // tall" means. Cheap enough to just re-measure.
  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  return (
    <textarea
      {...rest}
      ref={ref}
      value={value}
      onChange={(e) => {
        onChange?.(e);
        resize();
      }}
      className={className}
    />
  );
});

export default AutoTextarea;
