// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import ResetConfirmModal from '../ResetConfirmModal';

afterEach(cleanup);

const defaultProps = {
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('ResetConfirmModal', () => {
  it('renders the confirmation text', () => {
    const { getByText } = render(
      React.createElement(ResetConfirmModal, defaultProps),
    );
    expect(getByText('Reset OpenTrace?')).toBeDefined();
    expect(
      getByText('This will reload the page and clear the current session.'),
    ).toBeDefined();
  });

  it('calls onConfirm when Reset is clicked', () => {
    const onConfirm = vi.fn();
    const { getByTestId } = render(
      React.createElement(ResetConfirmModal, { ...defaultProps, onConfirm }),
    );
    fireEvent.click(getByTestId('reset-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    const { getByTestId } = render(
      React.createElement(ResetConfirmModal, { ...defaultProps, onCancel }),
    );
    fireEvent.click(getByTestId('reset-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    const { getByTestId } = render(
      React.createElement(ResetConfirmModal, { ...defaultProps, onCancel }),
    );
    fireEvent.click(getByTestId('reset-backdrop'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not call onCancel when modal card is clicked', () => {
    const onCancel = vi.fn();
    const { getByText } = render(
      React.createElement(ResetConfirmModal, { ...defaultProps, onCancel }),
    );
    // Click inside the modal card (on the heading)
    fireEvent.click(getByText('Reset OpenTrace?'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});
