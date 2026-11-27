import React from 'react';
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input } from 'nakomponents';

const DEFAULT_LABEL = 'Manual token';

// Asks for a label before minting a manual sync token.
export function TokenLabelDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = React.useState(DEFAULT_LABEL);
  const close = () => {
    setName(DEFAULT_LABEL);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={next => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            onCreate(name);
            close();
          }}
        >
          <DialogHeader>
            <DialogTitle>Device label</DialogTitle>
          </DialogHeader>
          <Input aria-label="Device label" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit">Create token</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
