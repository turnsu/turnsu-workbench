import Foundation

enum RuntimeMutation: Hashable {
    case setSelection(RuntimeSelectionState)
    case appendTask(UserTask)
    case appendWatchlistItem(WatchlistItem)
    case updateAlertStatus(alertID: UUID, status: AlertStatus)
    case setProactiveData(ProactiveRuntimeData)
    case setCommandStatus(String)
}
