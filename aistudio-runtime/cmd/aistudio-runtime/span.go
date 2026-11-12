package main

import "fmt"

// arrayElementSpan is from AIStudio2API internal/aistudio/runtime_native.go,
// bab7209eef0d5a8f9baed4652d7e4158a3adad7b (MIT; ../../LICENSE).
// Offsets count bytes, matching GenerateTurn's raw UTF-8 body slices.
func arrayElementSpan(body []byte, index int) (int, int, error) {
	depth, element, start := 0, 0, -1
	inString, escaped := false, false
	for position, char := range body {
		if inString {
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				inString = false
			}
			continue
		}
		switch char {
		case '"':
			inString = true
		case '[', '{':
			depth++
			if depth == 1 {
				continue
			}
		case ']', '}':
			depth--
			if depth == 0 {
				if element == index && start >= 0 {
					return start, position, nil
				}
				return 0, 0, fmt.Errorf("top-level array has only %d elements", element+1)
			}
		case ',':
			if depth == 1 {
				if element == index {
					return start, position, nil
				}
				element++
				start = -1
				continue
			}
		}
		if depth >= 1 && element == index && start < 0 {
			start = position
		}
	}
	return 0, 0, fmt.Errorf("incomplete top-level JSON array")
}
