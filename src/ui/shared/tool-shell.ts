/**
 * Shared shell behavior for collapsible sections and common UI affordances. It keeps repeated interaction patterns consistent across tool apps.
 */
const EXPAND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"></path></svg>';
const COLLAPSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14l5-5 5 5z"></path></svg>';

export interface ToolShellController {
  getExpanded: () => boolean;
  setExpanded: (nextExpanded: boolean) => void;
  toggle: () => void;
  dispose: () => void;
}

interface CreateToolShellControllerOptions {
  shell: HTMLElement | null;
  toggleButton: HTMLButtonElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onScrollAfterExpand?: () => void;
  onRender?: () => void;
}

interface CreateCompactRowShellControllerOptions {
  shell: HTMLElement | null;
  compactRow: HTMLElement | null;
  initialExpanded: boolean;
  onToggle?: (expanded: boolean) => void;
  onScrollAfterExpand?: () => void;
  onRender?: () => void;
}

function syncExpandButton(toggleButton: HTMLButtonElement | null, expanded: boolean): void {
  if (!toggleButton) {
    return;
  }
  const label = expanded ? 'Collapse' : 'Expand';
  toggleButton.title = label;
  toggleButton.setAttribute('aria-label', label);
  toggleButton.innerHTML = expanded ? COLLAPSE_ICON : EXPAND_ICON;
}

function syncShellClasses(shell: HTMLElement | null, expanded: boolean): void {
  if (!shell) {
    return;
  }
  shell.classList.toggle('expanded', expanded);
  shell.classList.toggle('collapsed', !expanded);
}

export function createToolShellController(options: CreateToolShellControllerOptions): ToolShellController {
  let shellElement = options.shell;
  let toggleButtonElement = options.toggleButton;
  let onToggleHandler = options.onToggle;
  let onScrollAfterExpandHandler = options.onScrollAfterExpand;
  let onRenderHandler = options.onRender;
  let isExpanded = options.initialExpanded;
  let disposed = false;
  let scrollTrackedForCurrentExpand = false;
  const shouldTrackScroll = typeof onScrollAfterExpandHandler === 'function';

  const applyExpandedState = (nextExpanded: boolean): void => {
    if (disposed) return;
    const wasExpanded = isExpanded;
    isExpanded = nextExpanded;
    syncShellClasses(shellElement, isExpanded);
    syncExpandButton(toggleButtonElement, isExpanded);
    if (!wasExpanded && isExpanded) {
      scrollTrackedForCurrentExpand = false;
    }
  };

  const toggle = (): void => {
    if (disposed) return;
    applyExpandedState(!isExpanded);
    onToggleHandler?.(isExpanded);
    onRenderHandler?.();
  };

  const handleScroll = (event?: Event): void => {
    if (disposed || !isExpanded || scrollTrackedForCurrentExpand) {
      return;
    }
    const targetNode = event?.target instanceof Node ? event.target : null;
    if (targetNode && shellElement && !shellElement.contains(targetNode)) {
      return;
    }
    scrollTrackedForCurrentExpand = true;
    onScrollAfterExpandHandler?.();
  };

  applyExpandedState(isExpanded);
  toggleButtonElement?.addEventListener('click', toggle);
  if (shouldTrackScroll) {
    shellElement?.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
  }

  return {
    getExpanded: () => isExpanded,
    setExpanded: applyExpandedState,
    toggle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      toggleButtonElement?.removeEventListener('click', toggle);
      if (shouldTrackScroll) {
        shellElement?.removeEventListener('scroll', handleScroll);
        document.removeEventListener('scroll', handleScroll, true);
      }
      shellElement = null;
      toggleButtonElement = null;
      onToggleHandler = undefined;
      onScrollAfterExpandHandler = undefined;
      onRenderHandler = undefined;
    },
  };
}

export function createCompactRowShellController(options: CreateCompactRowShellControllerOptions): ToolShellController {
  let compactRowElement = options.compactRow;
  let disposed = false;

  const controller = createToolShellController({
    shell: options.shell,
    toggleButton: null,
    initialExpanded: options.initialExpanded,
    onToggle: (expanded) => {
      compactRowElement?.setAttribute('aria-expanded', String(expanded));
      options.onToggle?.(expanded);
    },
    onScrollAfterExpand: options.onScrollAfterExpand,
    onRender: options.onRender,
  });

  compactRowElement?.setAttribute('aria-expanded', String(options.initialExpanded));

  const handleCompactClick = (): void => {
    if (disposed) return;
    controller.toggle();
  };

  const handleCompactKeydown = (event: KeyboardEvent): void => {
    if (disposed || (event.key !== 'Enter' && event.key !== ' ')) {
      return;
    }
    event.preventDefault();
    controller.toggle();
  };

  compactRowElement?.addEventListener('click', handleCompactClick);
  compactRowElement?.addEventListener('keydown', handleCompactKeydown);

  return {
    getExpanded: controller.getExpanded,
    setExpanded: controller.setExpanded,
    toggle: controller.toggle,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      compactRowElement?.removeEventListener('click', handleCompactClick);
      compactRowElement?.removeEventListener('keydown', handleCompactKeydown);
      compactRowElement = null;
      controller.dispose();
    },
  };
}
