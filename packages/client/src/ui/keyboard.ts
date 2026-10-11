export interface KeyboardHandlers {
  next: () => void;
  prev: () => void;
  first: () => void;
  last: () => void;
  deleteLast: () => void;
  undo: () => void;
  toggleMute: () => void;
  toggleMic: () => void;
  escape: () => void;
  /**
   * Space went down. Returns true when press-to-speak took it (the key is now held); false lets Space
   * keep its other meaning, next slide.
   */
  holdStart: () => boolean;
  /** Space came back up (or the window lost focus) after `holdStart` took it. */
  holdEnd: () => void;
}

/** Slide-clicker friendly shortcuts; ignored while typing in a field or when a dialog handles its own keys. */
export function installKeyboard(handlers: KeyboardHandlers, isDialogOpen: () => boolean): () => void {
  let spaceHeld = false;
  const release = () => {
    if (!spaceHeld) return;
    spaceHeld = false;
    handlers.holdEnd();
  };
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as Partial<HTMLElement> | null)?.tagName?.toLowerCase() ?? '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || isDialogOpen()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      handlers.undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        // A held key auto-repeats; while press-to-speak owns it those repeats mean nothing.
        if (spaceHeld) break;
        if (!e.repeat && handlers.holdStart()) spaceHeld = true;
        else handlers.next();
        break;
      case 'ArrowRight':
      case 'PageDown':
      case 'Enter':
      case 'ArrowDown':
        e.preventDefault();
        handlers.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
      case 'ArrowUp':
        e.preventDefault();
        handlers.prev();
        break;
      case 'Home':
        e.preventDefault();
        handlers.first();
        break;
      case 'End':
        e.preventDefault();
        handlers.last();
        break;
      case 'Backspace':
      case 'Delete':
        e.preventDefault();
        handlers.deleteLast();
        break;
      // toggles ignore auto-repeat: a key held down must not flip the mic on and off thirty times a second
      case 'm':
      case 'M':
        if (!e.repeat) handlers.toggleMute();
        break;
      case 'r':
      case 'R':
        if (!e.repeat) handlers.toggleMic();
        break;
      case 'Escape':
        handlers.escape();
        break;
      default:
        break;
    }
  };
  // The key-up is handled whatever has focus: a phrase must never stay open because a dialog opened
  // or focus moved while Space was down.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') release();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', release);
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', release);
  };
}
