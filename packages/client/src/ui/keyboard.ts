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
}

/** Slide-clicker friendly shortcuts; ignored while typing in a field or when a dialog handles its own keys. */
export function installKeyboard(handlers: KeyboardHandlers, isDialogOpen: () => boolean): () => void {
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName.toLowerCase() ?? '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || isDialogOpen()) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      handlers.undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
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
      case 'm':
      case 'M':
        handlers.toggleMute();
        break;
      case 'r':
      case 'R':
        handlers.toggleMic();
        break;
      case 'Escape':
        handlers.escape();
        break;
      default:
        break;
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
