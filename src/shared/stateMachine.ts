export type PositionState =
  | 'WATCHING'
  | 'CANDIDATE'
  | 'APPROVED'
  | 'ENTRY_PENDING'
  | 'PARTIALLY_FILLED'
  | 'OPEN'
  | 'TAKE_PROFIT_PARTIAL'
  | 'TRAILING'
  | 'EXIT_PENDING'
  | 'CLOSED'
  | 'EMERGENCY_EXIT'
  | 'RECONCILIATION_REQUIRED';

export const validTransitions: Record<PositionState, PositionState[]> = {
  WATCHING: ['CANDIDATE'],
  CANDIDATE: ['WATCHING', 'APPROVED'],
  APPROVED: ['ENTRY_PENDING', 'WATCHING'],
  ENTRY_PENDING: ['PARTIALLY_FILLED', 'OPEN', 'CLOSED', 'RECONCILIATION_REQUIRED'],
  PARTIALLY_FILLED: ['OPEN', 'ENTRY_PENDING', 'CLOSED', 'RECONCILIATION_REQUIRED'],
  OPEN: ['TAKE_PROFIT_PARTIAL', 'TRAILING', 'EXIT_PENDING', 'EMERGENCY_EXIT', 'RECONCILIATION_REQUIRED'],
  TAKE_PROFIT_PARTIAL: ['TRAILING', 'EXIT_PENDING', 'OPEN', 'EMERGENCY_EXIT'],
  TRAILING: ['EXIT_PENDING', 'OPEN', 'EMERGENCY_EXIT'],
  EXIT_PENDING: ['CLOSED', 'RECONCILIATION_REQUIRED'],
  CLOSED: [],
  EMERGENCY_EXIT: ['CLOSED', 'RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['OPEN', 'CLOSED', 'WATCHING'],
};

export class PositionStateMachine {
  private state: PositionState = 'WATCHING';

  getState(): PositionState {
    return this.state;
  }

  transition(to: PositionState): boolean {
    const allowed = validTransitions[this.state];
    if (!allowed.includes(to)) {
      return false;
    }
    this.state = to;
    return true;
  }

  force(to: PositionState): void {
    this.state = to;
  }
}

export const positionStateMachine = new PositionStateMachine();
export default positionStateMachine;
