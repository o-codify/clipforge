"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null), id=useId();
  useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  return createPortal(<dialog ref={ref} className={`workspace-dialog${wide?" workspace-dialog-wide":""}`} aria-labelledby={id} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="dialog-frame"><header className="dialog-heading"><h2 id={id}>{title}</h2><button className="btn" aria-label="Закрыть окно" onClick={onClose}>×</button></header><div className="dialog-content">{children}</div></div>
  </dialog>,document.body);
}
