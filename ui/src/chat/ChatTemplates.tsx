interface Props {
  onSelect: (prompt: string) => void;
}

const TEMPLATES = [
  {
    label: "Overview",
    prompt: "Give me an overview of this system's architecture. What node types exist and how are they connected?",
  },
  {
    label: "List services",
    prompt: "List all the services in this graph and briefly describe what each one does based on its connections.",
  },
  {
    label: "Find dependencies",
    prompt: "What are the most critical dependencies in this system? Which nodes have the most incoming connections?",
  },
  {
    label: "Database usage",
    prompt: "What databases exist in this graph and which services connect to them?",
  },
];

export default function ChatTemplates({ onSelect }: Props) {
  return (
    <div className="chat-templates">
      <div className="templates-header">Suggested questions</div>
      <div className="templates-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.label}
            className="template-chip"
            onClick={() => onSelect(t.prompt)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
