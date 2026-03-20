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

import type { ChatTemplate } from './types';

interface Props {
  templates: ChatTemplate[];
  onSelect: (prompt: string) => void;
}

export default function ChatTemplates({ templates, onSelect }: Props) {
  return (
    <div className="chat-templates" data-testid="chat-examples">
      <div className="templates-grid">
        {templates.map((t) => (
          <button
            key={t.label}
            className="template-card"
            onClick={() => onSelect(t.prompt)}
            data-testid={`chat-example-${t.label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <span className="template-card-label">{t.label}</span>
            <span className="template-card-desc">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
