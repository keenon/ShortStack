import { Parameter } from "../types";

interface Props {
  params: Parameter[];
  setParams: React.Dispatch<React.SetStateAction<Parameter[]>>;
}

export default function ParametersEditor({ params, setParams }: Props) {
  
  // ACTION: Add a new row
  function addRow() {
    const newParam: Parameter = {
      id: crypto.randomUUID(),
      key: "New Parameter",
      value: 0,
      unit: "mm", // Default unit
    };
    setParams([...params, newParam]);
  }

  // ACTION: Update a specific row
  function updateRow(
    id: string,
    field: keyof Parameter,
    newValue: string | number
  ) {
    setParams((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, [field]: newValue } : item
      )
    );
  }

  // ACTION: Delete a row
  function deleteRow(id: string) {
    setParams((prev) => prev.filter((item) => item.id !== id));
  }

  return (
    <div className="editor-content">
      <h2>Parameters Editor</h2>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th style={{ width: "100px" }}>Unit</th>
            <th style={{ width: "50px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {params.map((item) => (
            <tr key={item.id}>
              <td>
                <input
                  type="text"
                  value={item.key}
                  onChange={(e) => updateRow(item.id, "key", e.target.value)}
                />
              </td>
              <td>
                <input
                  type="number"
                  value={item.value}
                  onChange={(e) =>
                    updateRow(item.id, "value", Number(e.target.value))
                  }
                />
              </td>
              <td>
                <select
                  value={item.unit}
                  onChange={(e) => updateRow(item.id, "unit", e.target.value)}
                >
                  <option value="mm">mm</option>
                  <option value="in">in</option>
                </select>
              </td>
              <td>
                <button className="danger" onClick={() => deleteRow(item.id)}>
                  X
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="add-btn" onClick={addRow}>
        + Add Parameter
      </button>
    </div>
  );
}