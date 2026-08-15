import {
  createElement,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
}

export interface MenuLabel {
  type: 'label'
  id: string
  text: string
}

export interface MenuSeparator {
  type: 'separator'
  id: string
}

export type MenuEntry = MenuItem | MenuLabel | MenuSeparator

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }): ReactNode {
  const { variant: _variant, ...button } = props
  return createElement('button', { type: 'button', ...button })
}

export function IconChevronDownOutline14(props: { className?: string }): ReactNode {
  return createElement('svg', { className: props.className, 'aria-hidden': true })
}

export function Menu(props: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  selectedId?: string
  onSelect: (id: string) => void
  onClose: () => void
}): ReactNode {
  const rows = props.items.map((item) => {
    if ('type' in item && item.type === 'label') return createElement('div', { key: item.id }, item.text)
    if ('type' in item && item.type === 'separator') return createElement('hr', { key: item.id })
    return createElement('button', {
      key: item.id,
      type: 'button',
      role: 'menuitem',
      disabled: item.disabled,
      onClick: () => { props.onSelect(item.id) },
    }, item.label)
  })
  return createElement('span', null,
    props.anchor,
    props.open ? createElement('div', { role: 'menu' }, rows) : null)
}
