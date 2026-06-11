/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useRef, useState } from 'react';
import './themed-select.css';

export interface ThemedSelectOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  value: T;
  options: ThemedSelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * Themed dropdown that mirrors the ThemeSelector pattern — same colors,
 * hover treatment, and check-mark for the selected option. Used in
 * place of native ``<select>`` where the OS-rendered popup doesn't
 * pick up our theme variables (only light/dark via ``color-scheme``).
 */
export function ThemedSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const buttonLabel = selected?.label ?? placeholder ?? '';

  return (
    <div className="themed-select" ref={wrapperRef}>
      <button
        type="button"
        className={`themed-select__trigger${open ? ' themed-select__trigger--open' : ''}`}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span
          className={`themed-select__label${selected ? '' : ' themed-select__label--placeholder'}`}
        >
          {buttonLabel}
        </span>
        <svg
          className="themed-select__chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="themed-select__menu" role="listbox">
          {options.length === 0 ? (
            <div className="themed-select__empty">No options</div>
          ) : (
            options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                className={`themed-select__option${opt.value === value ? ' themed-select__option--selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {opt.value === value && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
