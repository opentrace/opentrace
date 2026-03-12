import React, { Suspense, type HTMLAttributes } from 'react';
import type { Components } from 'react-markdown';

const MermaidDiagram = React.lazy(() => import('./MermaidDiagram'));

function CodeBlock({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement>) {
  const isMermaid = className === 'language-mermaid';

  if (isMermaid && typeof children === 'string') {
    return (
      <Suspense>
        <MermaidDiagram code={children.trimEnd()} />
      </Suspense>
    );
  }

  return (
    <code className={className} {...rest}>
      {children}
    </code>
  );
}

export const markdownComponents: Components = {
  code: CodeBlock,
};
