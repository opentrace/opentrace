import { useEffect, useRef, useState } from 'react';
import { applyTheme, applyMode, loadTheme, loadMode } from '../config/theme';

export function useTheme() {
  const [theme, setThemeState] = useState(loadTheme);
  const [mode, setModeState] = useState(loadMode);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const setTheme = (t: string) => setThemeState(t);
  const toggleMode = () =>
    setModeState((m) => (m === 'dark' ? 'light' : 'dark'));

  return { theme, mode, setTheme, toggleMode, open, setOpen, dropdownRef };
}
