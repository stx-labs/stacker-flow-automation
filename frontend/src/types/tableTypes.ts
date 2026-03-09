import {
  Column,
  ColumnDef,
  ColumnFiltersState,
  OnChangeFn,
  SortingState,
} from "@tanstack/react-table";

export interface RowData {
  stacker: string;
  start_cycle: number;
  end_cycle: number;
  pox_address: string;
  amount_ustx: number;
  amount_stx: number;
  txid: string;
  function_name: string;
  reward_cycle: number;
  reward_index: number;
}

export type CustomColumnDef<TData> = ColumnDef<TData> & {
  filterType?: "text" | "number" | "select";
  accessorKey?: string;
};

export interface FilterProps<TData> {
  column: Column<TData, unknown> & {
    columnDef: CustomColumnDef<TData>;
    getFilterValue: () => string | number;
    setFilterValue: (value: string | number) => void;
  };
}

export interface TableComponentProps {
  columns: CustomColumnDef<RowData>[];
  data: RowData[];
  columnVisibility: Record<string, boolean>;
  setColumnVisibility: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  filters: ColumnFiltersState;
  onFiltersChange: OnChangeFn<ColumnFiltersState>;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
}

export function isCustomColumn<TData>(
  column: Column<TData, unknown>
): column is Column<TData, unknown> & {
  columnDef: CustomColumnDef<TData>;
  getFilterValue: () => string | number;
  setFilterValue: (value: string | number) => void;
} {
  return (
    "getFilterValue" in column &&
    "setFilterValue" in column &&
    "columnDef" in column
  );
}
