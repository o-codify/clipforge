"use client";
import * as RadixSelect from "@radix-ui/react-select";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { useRef, useState, type ReactNode } from "react";

const emptyValue = "__clipforge_empty__";
const Chevron = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>;
type Option<T extends string> = { value:T; label:string; content?:ReactNode; disabled?:boolean };
interface SelectProps<T extends string> { value:T; onValueChange:(value:T)=>void; options:Option<T>[]; label:string; disabled?:boolean }

/** Shared accessible menu; the popup is themed as well as the trigger. */
export function Select<T extends string>({value,onValueChange,options,label,disabled}:SelectProps<T>){
  const trigger=useRef<HTMLButtonElement>(null);
  const [container,setContainer]=useState<HTMLElement>();
  return <RadixSelect.Root value={value || emptyValue} onOpenChange={open=>{if(open)setContainer(trigger.current?.closest("dialog")??undefined);}} onValueChange={v=>onValueChange((v===emptyValue?"":v) as T)} disabled={disabled}>
    <RadixSelect.Trigger ref={trigger} className="field select-trigger" aria-label={label}><RadixSelect.Value/><RadixSelect.Icon><Chevron/></RadixSelect.Icon></RadixSelect.Trigger>
    <RadixSelect.Portal container={container}><RadixSelect.Content className="select-menu" position="popper" sideOffset={6} collisionPadding={12}>
      <RadixSelect.ScrollUpButton className="select-scroll">⌃</RadixSelect.ScrollUpButton>
      <RadixSelect.Viewport className="select-viewport">{options.map(option=><RadixSelect.Item className="select-option" textValue={option.label} value={option.value || emptyValue} key={option.value} disabled={option.disabled}>
        <RadixSelect.ItemText>{option.content??option.label}</RadixSelect.ItemText><RadixSelect.ItemIndicator className="select-check">✓</RadixSelect.ItemIndicator>
      </RadixSelect.Item>)}</RadixSelect.Viewport>
      <RadixSelect.ScrollDownButton className="select-scroll">⌄</RadixSelect.ScrollDownButton>
    </RadixSelect.Content></RadixSelect.Portal>
  </RadixSelect.Root>;
}

/** Searchable catalog with free-text entry, replacing the browser datalist. */
export function SearchSelect({value,onValueChange,options,label}:{value:string;onValueChange:(value:string)=>void;options:Option<string>[];label:string}){
  const [open,setOpen]=useState(false),[query,setQuery]=useState("");
  const filtered=options.filter(o=>o.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const choose=(next:string)=>{onValueChange(next);setOpen(false);};
  return <Popover.Root open={open} onOpenChange={v=>{setOpen(v);if(v)setQuery("");}}>
    <Popover.Trigger asChild><button type="button" className="field select-trigger search-select-trigger" role="combobox" aria-expanded={open} aria-label={label}>{value || label}<Chevron/></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="select-menu search-select-menu" sideOffset={6} align="start" collisionPadding={12}>
      <Command shouldFilter={false} label={label}>
        <Command.Input className="select-search" aria-label={`Поиск: ${label}`} placeholder="Найти или ввести название…" value={query} onValueChange={setQuery}/>
        <Command.List className="select-viewport search-select-list" label="Категории">
          <Command.Empty className="select-empty">Нет подходящих вариантов</Command.Empty>
          {filtered.map(o=><Command.Item className="select-option" key={o.value} value={o.value} disabled={o.disabled} onSelect={()=>choose(o.value)}>{o.label}{o.value===value&&<span className="select-check">✓</span>}</Command.Item>)}
          {query.trim()&&!options.some(o=>o.label.toLocaleLowerCase()===query.trim().toLocaleLowerCase())&&<Command.Item className="select-option" value={`custom:${query}`} onSelect={()=>choose(query.trim())}>Использовать «{query.trim()}»</Command.Item>}
        </Command.List>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
