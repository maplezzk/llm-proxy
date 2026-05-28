import Foundation

extension Notification.Name {
    /// 控制台内配置变更（Provider/Adapter 的增删改），触发菜单栏重载
    static let configDidChange = Notification.Name("llm-proxy.configDidChange")
}
