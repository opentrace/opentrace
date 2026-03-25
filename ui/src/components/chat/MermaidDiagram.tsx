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

import { useEffect, useId, useState } from 'react';
import './MermaidDiagram.css';

// Module-level promise — loaded once, shared across all instances
let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'dark',
      });
      return mod;
    });
  }
  return mermaidPromise;
}

interface Props {
  code: string;
}

export default function MermaidDiagram({ code }: Props) {
  const rawId = useId();
  // Strip colons from React's useId — mermaid uses the ID as a CSS selector
  const diagramId = 'mermaid-' + rawId.replace(/:/g, '');

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    loadMermaid()
      .then(async (mod) => {
        if (cancelled) return;
        const { svg: rendered } = await mod.default.render(diagramId, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSvg(null);
          setError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code, diagramId]);

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-error">
        <span className="mermaid-error-label">Diagram error</span>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-diagram mermaid-loading">
        <div className="mermaid-loading-spinner" />
        <span>Rendering diagram…</span>
      </div>
    );
  }

  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
