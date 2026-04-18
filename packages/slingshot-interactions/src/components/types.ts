/** Message kinds that can own an interactive component tree. */
export type MessageKind =
  | 'chat:message'
  | 'community:thread'
  | 'community:reply'
  | 'community:post';

/** Button presentation styles supported by the component schema. */
export type ButtonStyle = 'primary' | 'secondary' | 'danger' | 'success' | 'link';
/** Select-menu variants supported in v1. */
export type SelectMenuKind = 'string';

/** Clickable button component embedded in a message. */
export interface ButtonComponent {
  readonly type: 'button';
  readonly actionId?: string;
  readonly label: string;
  readonly style?: ButtonStyle;
  readonly url?: string;
  readonly disabled?: boolean;
  readonly permission?: string;
}

/** One selectable option inside a select menu. */
export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

/** Select-menu component embedded in a message. */
export interface SelectMenuComponent {
  readonly type: 'select';
  readonly kind?: SelectMenuKind;
  readonly actionId: string;
  readonly placeholder?: string;
  readonly options: readonly SelectOption[];
  readonly minValues?: number;
  readonly maxValues?: number;
  readonly disabled?: boolean;
  readonly permission?: string;
}

/** Text input used inside modal submissions. */
export interface TextInputComponent {
  readonly type: 'textInput';
  readonly actionId: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly value?: string;
  readonly required?: boolean;
}

/** Union of actionable components allowed inside an action row. */
export type ActionComponent = ButtonComponent | SelectMenuComponent | TextInputComponent;

/** Horizontal layout row containing one or more interactive children. */
export interface ActionRow {
  readonly type: 'actionRow';
  readonly children: readonly ActionComponent[];
}

/** Full component tree attached to a message. */
export type ComponentTree = readonly ActionRow[];

/** Modal payload returned by a handler. */
export interface ModalComponent {
  readonly title: string;
  readonly actionId: string;
  readonly components: ComponentTree;
}
