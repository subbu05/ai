import { useEffect, useState, type ReactNode } from "react";
import type { Widget } from "../lib/types";
import { actions } from "../lib/store";

/**
 * Frame shared by every widget kind: drag-to-reorder, double-click rename, collapse, delete.
 * `tools` go in the header next to the standard buttons; `children` is the body.
 */
export function WidgetShell({ widget, count, tools, className = "", children }: {
  widget: Widget; count?: ReactNode; tools?: ReactNode; className?: string; children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(widget.title);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => setTitle(widget.title), [widget.title]);

  const commitTitle = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== widget.title) void actions.patchWidget(widget.id, { title: t });
    else setTitle(widget.title);
  };

  return (
    <article
      id={`w-${widget.id}`}
      className={`widget ${className} ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-widget")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        const id = e.dataTransfer.getData("application/x-widget");
        if (id) void actions.moveWidget(id, widget.id);
      }}
    >
      <div
        className="widget-head"
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-widget", widget.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        <span className="grip" title="Drag to reorder">⋮⋮</span>
        {editing ? (
          <input
            className="title-input"
            autoFocus
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") { setTitle(widget.title); setEditing(false); }
            }}
          />
        ) : (
          <h2 className="widget-title" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {widget.title}
          </h2>
        )}
        {count !== undefined && <span className="count">{count}</span>}
        <div className="widget-tools">
          {tools}
          <button className="icon-btn" title="Rename" onClick={() => setEditing(true)}>✎</button>
          <button className="icon-btn" title={widget.collapsed ? "Expand" : "Collapse"}
            onClick={() => void actions.patchWidget(widget.id, { collapsed: !widget.collapsed })}>
            {widget.collapsed ? "▸" : "▾"}
          </button>
          <button className="icon-btn danger" title="Delete widget"
            onClick={() => { if (confirm(`Delete widget "${widget.title}"?`)) void actions.deleteWidget(widget.id); }}>
            ✕
          </button>
        </div>
      </div>
      {!widget.collapsed && children}
    </article>
  );
}
