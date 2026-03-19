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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { AddRepoModal, detectProvider } from '@opentrace/components/indexing';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const defaultProps = {
  onClose: vi.fn(),
  onSubmit: vi.fn(),
  dismissable: true,
};

describe('detectProvider', () => {
  it('detects github', () => {
    expect(detectProvider('https://github.com/owner/repo')).toBe('github');
  });
  it('detects gitlab', () => {
    expect(detectProvider('https://gitlab.com/owner/repo')).toBe('gitlab');
  });
  it('detects bitbucket', () => {
    expect(detectProvider('https://bitbucket.org/workspace/repo')).toBe(
      'bitbucket',
    );
  });
  it('detects azuredevops from dev.azure.com', () => {
    expect(detectProvider('https://dev.azure.com/org/project/_git/repo')).toBe(
      'azuredevops',
    );
  });
  it('detects azuredevops from visualstudio.com', () => {
    expect(
      detectProvider('https://org.visualstudio.com/project/_git/repo'),
    ).toBe('azuredevops');
  });
  it('returns null for unknown', () => {
    expect(detectProvider('https://example.com/repo')).toBeNull();
  });
});

describe('AddRepoModal', () => {
  it('renders the URL input by default', () => {
    const { getByTestId } = render(
      React.createElement(AddRepoModal, defaultProps),
    );
    expect(getByTestId('repo-url-input')).toBeDefined();
  });

  it('shows example repo chips when no provider detected', () => {
    const { getByText } = render(
      React.createElement(AddRepoModal, defaultProps),
    );
    expect(getByText('OpenTelemetry Demo')).toBeDefined();
    expect(getByText('Podinfo')).toBeDefined();
  });

  it('submits index-repo message with URL', () => {
    const onSubmit = vi.fn();
    const { getByTestId, getByText } = render(
      React.createElement(AddRepoModal, { ...defaultProps, onSubmit }),
    );
    const input = getByTestId('repo-url-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/owner/repo' },
    });
    fireEvent.click(getByText('Add & Index'));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'index-repo',
        repoUrl: 'https://github.com/owner/repo',
      }),
    );
  });

  describe('history autocomplete', () => {
    beforeEach(() => {
      localStorage.setItem(
        'ot_repo_history',
        JSON.stringify([
          'https://github.com/foo/bar',
          'https://gitlab.com/baz/qux',
        ]),
      );
    });

    it('shows history dropdown on input focus', () => {
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, defaultProps),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.focus(input);
      expect(getByText('Recent')).toBeDefined();
      expect(getByText('github.com/foo/bar')).toBeDefined();
      expect(getByText('gitlab.com/baz/qux')).toBeDefined();
    });

    it('filters history as user types', () => {
      const { getByTestId, queryByText } = render(
        React.createElement(AddRepoModal, defaultProps),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'gitlab' } });
      expect(queryByText('github.com/foo/bar')).toBeNull();
      expect(queryByText('gitlab.com/baz/qux')).toBeDefined();
    });

    it('selects a history item on click', () => {
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, defaultProps),
      );
      const input = getByTestId('repo-url-input') as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.mouseDown(getByText('github.com/foo/bar'));
      expect(input.value).toBe('https://github.com/foo/bar');
    });

    it('closes dropdown on Escape', () => {
      const { getByTestId, queryByText } = render(
        React.createElement(AddRepoModal, defaultProps),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.focus(input);
      expect(queryByText('Recent')).toBeDefined();
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(queryByText('Recent')).toBeNull();
    });

    it('saves submitted URL to history', () => {
      const onSubmit = vi.fn();
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, { ...defaultProps, onSubmit }),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.change(input, {
        target: { value: 'https://github.com/new/repo' },
      });
      fireEvent.click(getByText('Add & Index'));
      const stored = JSON.parse(
        localStorage.getItem('ot_repo_history') ?? '[]',
      );
      expect(stored[0]).toBe('https://github.com/new/repo');
    });

    it('deduplicates URLs in history (most recent first)', () => {
      const onSubmit = vi.fn();
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, { ...defaultProps, onSubmit }),
      );
      const input = getByTestId('repo-url-input');
      // Submit an existing URL
      fireEvent.change(input, {
        target: { value: 'https://gitlab.com/baz/qux' },
      });
      fireEvent.click(getByText('Add & Index'));
      const stored = JSON.parse(
        localStorage.getItem('ot_repo_history') ?? '[]',
      );
      expect(stored[0]).toBe('https://gitlab.com/baz/qux');
      expect(
        stored.filter((u: string) => u === 'https://gitlab.com/baz/qux'),
      ).toHaveLength(1);
    });

    it('shows already-indexed notice and disables submit for duplicate repo', () => {
      const onSubmit = vi.fn();
      const indexedRepos = [
        { name: 'my-repo', url: 'https://github.com/owner/repo' },
      ];
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, {
          ...defaultProps,
          onSubmit,
          indexedRepos,
        }),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.change(input, {
        target: { value: 'https://github.com/owner/repo' },
      });
      expect(getByText('is already indexed')).toBeDefined();
      expect(getByText('my-repo')).toBeDefined();
      // Submit button should be disabled
      const submitBtn = getByText('Add & Index').closest('button')!;
      expect(submitBtn.disabled).toBe(true);
      // Submitting should not call onSubmit
      fireEvent.click(submitBtn);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('matches repos with different URL formats (SSH vs HTTPS)', () => {
      const indexedRepos = [
        { name: 'my-repo', url: 'https://github.com/owner/repo' },
      ];
      const { getByTestId, getByText } = render(
        React.createElement(AddRepoModal, {
          ...defaultProps,
          indexedRepos,
        }),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.change(input, {
        target: { value: 'git@github.com:owner/repo.git' },
      });
      expect(getByText('is already indexed')).toBeDefined();
    });

    it('removes a history item when trash icon is clicked', () => {
      const { getByTestId, getAllByLabelText, queryByText } = render(
        React.createElement(AddRepoModal, defaultProps),
      );
      const input = getByTestId('repo-url-input');
      fireEvent.focus(input);
      const removeButtons = getAllByLabelText('Remove from history');
      expect(removeButtons).toHaveLength(2);
      // Remove the first item (github.com/foo/bar)
      fireEvent.mouseDown(removeButtons[0]);
      expect(queryByText('github.com/foo/bar')).toBeNull();
      expect(queryByText('gitlab.com/baz/qux')).toBeDefined();
      const stored = JSON.parse(
        localStorage.getItem('ot_repo_history') ?? '[]',
      );
      expect(stored).toEqual(['https://gitlab.com/baz/qux']);
    });
  });
});
