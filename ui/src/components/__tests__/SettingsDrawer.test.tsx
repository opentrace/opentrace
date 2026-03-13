// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

afterEach(cleanup);

const mockStore = {
  clearGraph: vi.fn().mockResolvedValue(undefined),
  setLimits: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../store', () => ({
  useStore: () => ({ store: mockStore }),
}));

vi.mock('../../config/summarization', () => ({
  loadSummarizerStrategy: vi.fn(() => 'template'),
  saveSummarizerStrategy: vi.fn(),
}));

import SettingsDrawer from '../SettingsDrawer';
import { saveSummarizerStrategy } from '../../config/summarization';

beforeEach(() => {
  vi.clearAllMocks();
});

function renderDrawer(overrides?: Record<string, unknown>) {
  const defaultProps = {
    onClose: vi.fn(),
    onGraphCleared: vi.fn(),
    onLimitsChanged: vi.fn(),
    ...overrides,
  };
  return render(React.createElement(SettingsDrawer, defaultProps));
}

describe('SettingsDrawer', () => {
  it('renders settings sections', () => {
    const { getByText } = renderDrawer();
    expect(getByText('Settings')).toBeDefined();
    expect(getByText('Summarization')).toBeDefined();
    expect(getByText('Clear Database')).toBeDefined();
  });

  it('clear graph shows confirmation on first click', () => {
    const { getByText, queryByText } = renderDrawer();
    expect(queryByText('Are you sure?')).toBeNull();
    fireEvent.click(getByText('Clear Database'));
    expect(getByText('Are you sure?')).toBeDefined();
  });

  it('strategy selector persists choice', () => {
    const { getByText } = renderDrawer();
    fireEvent.click(getByText('Disabled'));
    expect(saveSummarizerStrategy).toHaveBeenCalledWith('none');
  });

  it('strategy selector switches to ML', () => {
    const { getByText } = renderDrawer();
    fireEvent.click(getByText('ML Model'));
    expect(saveSummarizerStrategy).toHaveBeenCalledWith('ml');
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    const { container } = renderDrawer({ onClose });
    const closeBtn = container.querySelector('.close-btn')!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('confirm clear calls store.clearGraph and fires onGraphCleared', async () => {
    const onGraphCleared = vi.fn();
    const { getByText } = renderDrawer({ onGraphCleared });

    fireEvent.click(getByText('Clear Database'));
    fireEvent.click(getByText('Yes, clear everything'));

    await waitFor(() => {
      expect(mockStore.clearGraph).toHaveBeenCalled();
      expect(onGraphCleared).toHaveBeenCalled();
    });
  });
});
