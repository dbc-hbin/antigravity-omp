package main

// Sparse JSON decoding is adapted from AIStudio2API internal/aistudio/decoder.go
// at bab7209eef0d5a8f9baed4652d7e4158a3adad7b (MIT; ../../LICENSE).
import (
 "bufio"
 "bytes"
 "encoding/json"
 "fmt"
 "io"
 "unicode"
)

type sparseJSONReader struct {
	source        *bufio.Reader
	pending       []byte
	hole          [5]byte
	inString      bool
	escaped       bool
	previousToken byte
}

func newSparseJSONReader(source io.Reader) io.Reader {
	return &sparseJSONReader{source: bufio.NewReader(source)}
}

func (r *sparseJSONReader) Read(destination []byte) (int, error) {
	written := 0
	for written < len(destination) {
		if len(r.pending) > 0 {
			count := copy(destination[written:], r.pending)
			r.pending = r.pending[count:]
			written += count
			continue
		}
		if written > 0 && r.source.Buffered() == 0 {
			return written, nil
		}
		value, err := r.source.ReadByte()
		if err != nil {
			if written > 0 {
				return written, nil
			}
			return 0, err
		}
		if r.emptySlot(value) {
			r.pending = append(append(r.hole[:0], "null"...), value)
			continue
		}
		destination[written] = value
		written++
	}
	return written, nil
}

// emptySlot 按 value 更新扫描状态，返回 value 之前是否为数组空位
func (r *sparseJSONReader) emptySlot(value byte) bool {
	if r.inString {
		if r.escaped {
			r.escaped = false
		} else if value == '\\' {
			r.escaped = true
		} else if value == '"' {
			r.inString = false
		}
		return false
	}
	if value == '"' {
		r.inString = true
	}
	empty := value == ',' && (r.previousToken == '[' || r.previousToken == ',') || value == ']' && r.previousToken == ','
	if !unicode.IsSpace(rune(value)) {
		r.previousToken = value
	}
	return empty
}

func decodeJSONValue(raw []byte) (json.RawMessage, error) {
	decoder := json.NewDecoder(newSparseJSONReader(bytes.NewReader(raw)))
	decoder.UseNumber()
	var value json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("JSON+protobuf 包含多个根值")
		}
		return nil, err
	}
	return value, nil
}


func catalogArray(raw []byte) (json.RawMessage, error) {
 value, err := decodeJSONValue(raw)
 if err != nil { return nil, err }
 if len(value) == 0 || value[0] != '[' { return nil, fmt.Errorf("catalog response is not an array") }
 return value, nil
}
