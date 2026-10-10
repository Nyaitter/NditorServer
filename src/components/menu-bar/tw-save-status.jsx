import {connect} from 'react-redux';
import {FormattedMessage} from 'react-intl';
import PropTypes from 'prop-types';
import React from 'react';
import InlineMessages from '../../containers/inline-messages.jsx';
import SB3Downloader from '../../containers/sb3-downloader.jsx';
import {filterInlineAlerts} from '../../reducers/alerts';
import {getCloudProjectId} from '../../nyaitter/cloud-project-api.js';

import styles from './save-status.css';

const TWSaveStatus = ({
    alertsList,
    fileHandle,
    projectChanged,
    showSaveFilePicker
}) => {
    const [cloudProject, setCloudProject] = React.useState(Boolean(getCloudProjectId()));
    const [collaborationRole, setCollaborationRole] = React.useState(null);

    React.useEffect(() => {
        const updateProject = () => setCloudProject(Boolean(getCloudProjectId()));
        const updateCollaboration = event => setCollaborationRole(event.detail?.role || null);
        window.addEventListener('nditor-cloud-project-changed', updateProject);
        window.addEventListener('nditor-cloud-project-loaded', updateProject);
        window.addEventListener('nditor-collaboration-active', updateCollaboration);
        return () => {
            window.removeEventListener('nditor-cloud-project-changed', updateProject);
            window.removeEventListener('nditor-cloud-project-loaded', updateProject);
            window.removeEventListener('nditor-collaboration-active', updateCollaboration);
        };
    }, []);

    if (filterInlineAlerts(alertsList).length > 0) return <InlineMessages />;
    if (cloudProject || collaborationRole === 'guest' || !projectChanged) return null;
    return (
        <SB3Downloader
            showSaveFilePicker={showSaveFilePicker}
        >
            {(_className, _downloadProjectCallback, {smartSave}) => (
                <div
                    onClick={smartSave}
                    className={styles.saveNow}
                >
                    {fileHandle ? (
                        <FormattedMessage
                            defaultMessage="Save as {file}"
                            description="Menu bar item to save project to an existing file on the user's computer"
                            id="tw.menuBar.saveAs"
                            values={{
                                file: fileHandle.name
                            }}
                        />
                    ) : (
                        <FormattedMessage
                            defaultMessage="Save to your computer"
                            description="Menu bar item for downloading a project to your computer"
                            id="gui.menuBar.downloadToComputer"
                        />
                    )}
                </div>
            )}
        </SB3Downloader>
    );
};

TWSaveStatus.propTypes = {
    alertsList: PropTypes.arrayOf(PropTypes.object),
    fileHandle: PropTypes.shape({
        name: PropTypes.string
    }),
    projectChanged: PropTypes.bool,
    showSaveFilePicker: PropTypes.func
};

const mapStateToProps = state => ({
    alertsList: state.scratchGui.alerts.alertsList,
    fileHandle: state.scratchGui.tw.fileHandle,
    projectChanged: state.scratchGui.projectChanged
});

export default connect(
    mapStateToProps,
    () => ({})
)(TWSaveStatus);
