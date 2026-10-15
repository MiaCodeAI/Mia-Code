def clamp(value: float, low: float, high: float) -> float:
    if low > high:
        raise ValueError("low must not exceed high")
    return max(low, min(high, value))
