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
